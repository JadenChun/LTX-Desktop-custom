import crypto from 'crypto'
import dgram from 'dgram'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import os from 'os'
import { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { getDeviceId } from '../app-state'
import { listMcpProjects, getMcpProject } from '../mcp-project-store'
import type { LanSyncPeer, LanPairedDevice, LanPairingRequest, LanSyncIncomingRequest } from '../../shared/electron-api-schema'
import { buildTransferManifest, type TransferManifest } from './project-bundler'
import {
  listPaired,
  upsertPaired,
  removePaired,
  findPairedByDeviceId,
  findPairedByPairToken,
  generatePairToken,
  type PairedDevice,
} from './paired-devices'

// ── Constants ─────────────────────────────────────────────────────────────────
// Use 239.77.84.88 — private-use administratively-scoped multicast (239.0.0.0/8)
// Avoids conflict with real mDNS at 224.0.0.251 (owned by macOS mDNSResponder)
const MULTICAST_GROUP = '239.77.84.88'
const BEACON_PORT = 35354
const BEACON_INTERVAL_MS = 3000
const PEER_TIMEOUT_MS = 12000 // 4 missed beacons → evict

// ── Module state ──────────────────────────────────────────────────────────────
let enabled = true
let deviceId = '' // set during startLanSync
const deviceName = os.hostname()
const sessionToken = crypto.randomBytes(24).toString('base64url')

let udpSocket: dgram.Socket | null = null
let httpServer: http.Server | null = null
let httpPort: number | null = null
let beaconTimer: NodeJS.Timeout | null = null
let evictTimer: NodeJS.Timeout | null = null

const peers = new Map<string, LanSyncPeer>()
// Map of transferId → resolve function for the approval Promise
const pendingApprovals = new Map<string, (approved: boolean) => void>()
// Map of transferId → approved manifest (kept so /download can serve files)
const approvedManifests = new Map<string, TransferManifest>()
// Map of pairRequestId → resolve function for pair approval
const pendingPairRequests = new Map<string, (approved: boolean) => void>()

// In-process event bus consumed by sync-coordinator
export interface SyncNotifyEvent {
  fromDeviceId: string
  projectId: string
  updatedAt: number
}
export interface PairedPeerOnlineEvent {
  deviceId: string
  peer: LanSyncPeer
}
const syncEvents = new EventEmitter()
syncEvents.setMaxListeners(50)

export function onSyncNotify(listener: (event: SyncNotifyEvent) => void): () => void {
  syncEvents.on('notify', listener)
  return () => syncEvents.off('notify', listener)
}
export function onPairedPeerOnline(listener: (event: PairedPeerOnlineEvent) => void): () => void {
  syncEvents.on('paired-online', listener)
  return () => syncEvents.off('paired-online', listener)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastPeersChanged(): void {
  const list = Array.from(peers.values())
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-peers-changed', list)
  }
}

function broadcastPairedDevicesChanged(): void {
  const pairedWithOnlineStatus: LanPairedDevice[] = listPaired().map((p) => ({
    deviceId: p.deviceId,
    deviceName: p.deviceName,
    pairedAt: p.pairedAt,
    online: peers.has(p.deviceId),
    peer: peers.get(p.deviceId) ?? null,
  }))
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-paired-devices-changed', pairedWithOnlineStatus)
  }
}

/** Read a JSON request body. Rejects after 64KB. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
      catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function evictStalePeers(): void {
  const now = Date.now()
  let changed = false
  let pairedChanged = false
  for (const [id, peer] of peers.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
      peers.delete(id)
      changed = true
      if (findPairedByDeviceId(id)) pairedChanged = true
    }
  }
  if (changed) broadcastPeersChanged()
  if (pairedChanged) broadcastPairedDevicesChanged()
}

function getLocalIp(): string {
  const ifaces = os.networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

// ── UDP beacon ────────────────────────────────────────────────────────────────
function sendBeacon(): void {
  if (!udpSocket || !enabled || httpPort === null) return
  const payload = Buffer.from(
    JSON.stringify({ type: 'ltx-announce', deviceId, deviceName, port: httpPort, token: sessionToken, v: 1 }),
  )
  udpSocket.send(payload, BEACON_PORT, MULTICAST_GROUP, (err) => {
    if (err) logger.warn(`[LAN Sync] beacon send error: ${err.message}`)
  })
}

function startBeacon(): void {
  sendBeacon()
  beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS)
}

function stopBeacon(): void {
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
type AuthResult = { type: 'session' } | { type: 'paired'; device: PairedDevice } | null

function checkAuth(req: http.IncomingMessage): AuthResult {
  const auth = req.headers['authorization'] ?? ''
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length)
  if (token === sessionToken) return { type: 'session' }
  const paired = findPairedByPairToken(token)
  if (paired) return { type: 'paired', device: paired }
  return null
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? ''

  // POST /pair — unauthenticated endpoint (the receiver's user approves via dialog)
  if (req.method === 'POST' && url === '/pair') {
    return handlePairRequest(req, res)
  }

  const auth = checkAuth(req)
  if (!auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  // GET /projects — list project summaries
  if (req.method === 'GET' && url === '/projects') {
    const projects = listMcpProjects()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(projects))
    return
  }

  // GET /transfer/:projectId — returns manifest JSON after sender approval
  const transferMatch = url.match(/^\/transfer\/([^/]+)$/)
  if (req.method === 'GET' && transferMatch) {
    const projectId = decodeURIComponent(transferMatch[1])
    const transferId = crypto.randomUUID()

    // Build manifest to get size estimate (no disk I/O beyond stat calls)
    let manifest
    try { manifest = buildTransferManifest(projectId) } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Project not found: ${err}` }))
      return
    }

    // Paired callers skip the approval gate — they're pre-authorized.
    let approved = auth.type === 'paired'

    if (!approved) {
      // Look up project name for the approval dialog
      let projectName = projectId
      try { projectName = listMcpProjects().find(s => s.id === projectId)?.name ?? projectId } catch { /* best-effort */ }

      // Ask the sender's user to approve
      const fromDeviceName = (req.headers['x-device-name'] as string | undefined) ?? 'Unknown device'
      const incomingRequest: LanSyncIncomingRequest = {
        transferId, fromDeviceName, projectId, projectName,
        estimatedBytes: manifest.totalBytes,
      }
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('lan-sync-incoming-request', incomingRequest)
      }

      approved = await new Promise<boolean>((resolve) => {
        pendingApprovals.set(transferId, resolve)
        setTimeout(() => {
          if (pendingApprovals.has(transferId)) {
            pendingApprovals.delete(transferId)
            resolve(false)
          }
        }, 60_000)
      })
    }

    if (!approved) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Transfer denied by sender' }))
      return
    }

    // Store the approved manifest so the file endpoint can serve it
    approvedManifests.set(transferId, manifest)
    setTimeout(() => approvedManifests.delete(transferId), 10 * 60 * 1000) // expire after 10 min

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      transferId,
      project: manifest.project,
      files: manifest.files.map(f => ({ rel: f.rel, size: f.size })),
      totalBytes: manifest.totalBytes,
    }))
    return
  }

  // GET /download/:transferId/:encodedRel — stream a single raw file
  const downloadMatch = url.match(/^\/download\/([^/]+)\/(.+)$/)
  if (req.method === 'GET' && downloadMatch) {
    const transferId = downloadMatch[1]
    const rel = decodeURIComponent(downloadMatch[2])
    const manifest = approvedManifests.get(transferId)
    if (!manifest) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown or expired transfer' }))
      return
    }
    const entry = manifest.files.find(f => f.rel === rel)
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'File not in manifest' }))
      return
    }
    let stat
    try { stat = fs.statSync(entry.absolutePath) } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'File not found on sender' }))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
    })
    const fileStream = fs.createReadStream(entry.absolutePath)
    fileStream.on('error', (err) => {
      logger.error(`[LAN Sync] file read error for ${entry.absolutePath}: ${err}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
    fileStream.pipe(res)
    return
  }

  // DELETE /pair — unpair the caller's device (auth must be their pair token)
  if (req.method === 'DELETE' && url === '/pair') {
    if (auth.type !== 'paired') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Pair token required' }))
      return
    }
    const removed = removePaired(auth.device.deviceId)
    broadcastPairedDevicesChanged()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ removed }))
    return
  }

  // GET /sync/catalog — projects this caller is synced with
  if (req.method === 'GET' && url === '/sync/catalog') {
    if (auth.type !== 'paired') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Pair token required' }))
      return
    }
    const callerDeviceId = auth.device.deviceId
    const entries: Array<{ projectId: string; updatedAt: number; name?: string }> = []
    for (const summary of listMcpProjects()) {
      try {
        const project = getMcpProject(summary.id)
        const syncedWith = Array.isArray(project.syncedWith) ? project.syncedWith as unknown[] : []
        if (syncedWith.includes(callerDeviceId)) {
          entries.push({
            projectId: summary.id,
            updatedAt: summary.updatedAt ?? 0,
            name: summary.name,
          })
        }
      } catch { /* skip */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(entries))
    return
  }

  // POST /sync/notify — "I changed project X, pull if you want"
  if (req.method === 'POST' && url === '/sync/notify') {
    if (auth.type !== 'paired') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Pair token required' }))
      return
    }
    let body: unknown
    try { body = await readJsonBody(req) } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid body' }))
      return
    }
    const rec = (body as Record<string, unknown>) ?? {}
    const projectId = typeof rec.projectId === 'string' ? rec.projectId : null
    const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : 0
    if (!projectId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing projectId' }))
      return
    }
    syncEvents.emit('notify', { fromDeviceId: auth.device.deviceId, projectId, updatedAt })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.writeHead(404)
  res.end()
}

/** Handles POST /pair — a peer asking to pair with us. User approves via dialog. */
async function handlePairRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: unknown
  try { body = await readJsonBody(req) } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid body' }))
    return
  }
  const rec = (body as Record<string, unknown>) ?? {}
  const fromDeviceId = typeof rec.deviceId === 'string' ? rec.deviceId : null
  const fromDeviceName = typeof rec.deviceName === 'string' ? rec.deviceName : 'Unknown device'
  if (!fromDeviceId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing deviceId' }))
    return
  }

  // Already paired? Re-issue the existing pair token (idempotent pairing).
  const existing = findPairedByDeviceId(fromDeviceId)
  if (existing) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      accepted: true,
      pairToken: existing.pairToken,
      deviceId,
      deviceName,
    }))
    return
  }

  const pairRequestId = crypto.randomUUID()
  const pairingEvent: LanPairingRequest = { pairRequestId, fromDeviceId, fromDeviceName }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-pairing-request', pairingEvent)
  }

  const approved = await new Promise<boolean>((resolve) => {
    pendingPairRequests.set(pairRequestId, resolve)
    setTimeout(() => {
      if (pendingPairRequests.has(pairRequestId)) {
        pendingPairRequests.delete(pairRequestId)
        resolve(false)
      }
    }, 60_000)
  })

  if (!approved) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ accepted: false, error: 'Pairing denied' }))
    return
  }

  const pairToken = generatePairToken()
  upsertPaired({
    deviceId: fromDeviceId,
    deviceName: fromDeviceName,
    pairToken,
    pairedAt: Date.now(),
  })
  broadcastPairedDevicesChanged()

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    accepted: true,
    pairToken,
    deviceId,
    deviceName,
  }))
}

function startHttpServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      handleHttpRequest(req, res).catch((err) => {
        logger.error(`[LAN Sync] HTTP handler error: ${err}`)
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      })
    })
    httpServer.listen(0, '0.0.0.0', () => {
      const addr = httpServer!.address()
      httpPort = typeof addr === 'object' && addr ? addr.port : null
      logger.info(`[LAN Sync] HTTP server listening on port ${httpPort}`)
      resolve()
    })
    httpServer.on('error', reject)
  })
}

// ── UDP socket ────────────────────────────────────────────────────────────────
function startUdpSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    socket.on('error', (err) => {
      logger.error(`[LAN Sync] UDP error: ${err.message}`)
    })

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString()) as Record<string, unknown>
        if (data.type !== 'ltx-announce') return
        if (data.deviceId === deviceId) return // ignore own beacons

        const peerId = data.deviceId as string
        const peer: LanSyncPeer = {
          id: peerId,
          deviceName: (data.deviceName as string) ?? 'Unknown',
          address: rinfo.address, // use actual source IP, not beacon payload
          port: data.port as number,
          lastSeen: Date.now(),
          token: data.token as string,
        }

        // Resolve address from the incoming packet (more reliable than beacon payload)
        const existing = peers.get(peerId)
        const changed = !existing || existing.port !== peer.port || existing.token !== peer.token

        const wasOffline = !existing
        peers.set(peerId, peer)
        if (changed || !existing) {
          broadcastPeersChanged()
          // If this peer is paired, also notify the paired list so online status updates
          if (findPairedByDeviceId(peerId)) {
            broadcastPairedDevicesChanged()
            if (wasOffline) syncEvents.emit('paired-online', { deviceId: peerId, peer })
          }
        }
      } catch { /* malformed packet, ignore */ }
    })

    socket.bind(BEACON_PORT, () => {
      try {
        socket.addMembership(MULTICAST_GROUP)
        socket.setMulticastTTL(4)
        socket.setBroadcast(true)
      } catch (err) {
        logger.warn(`[LAN Sync] multicast setup warning: ${err}`)
      }
      udpSocket = socket
      resolve()
    })

    socket.on('error', reject)
  })
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function startLanSync(): Promise<void> {
  try {
    deviceId = getDeviceId()
    // HTTP server must be ready before beaconing so the port is known
    await startHttpServer()
    await startUdpSocket()
    startBeacon()
    evictTimer = setInterval(evictStalePeers, 5000)
    logger.info(`[LAN Sync] started (deviceId=${deviceId})`)
  } catch (err) {
    logger.error(`[LAN Sync] failed to start: ${err}`)
  }
}

export function stopLanSync(): void {
  stopBeacon()
  if (evictTimer) { clearInterval(evictTimer); evictTimer = null }
  udpSocket?.close()
  udpSocket = null
  httpServer?.close()
  httpServer = null
  httpPort = null
  logger.info('[LAN Sync] stopped')
}

export function getLanSyncStatus(): { enabled: boolean; deviceName: string; port: number | null } {
  return { enabled, deviceName, port: httpPort }
}

export function setLanSyncEnabled(value: boolean): void {
  enabled = value
  if (!value) {
    stopBeacon()
  } else if (httpPort !== null) {
    startBeacon()
  }
}

export function getKnownPeers(): LanSyncPeer[] {
  return Array.from(peers.values())
}

export function refreshDiscovery(): void {
  // Clear stale peers immediately and re-announce so both sides rediscover each other
  peers.clear()
  broadcastPeersChanged()
  sendBeacon()
}

export function approveIncomingTransfer(transferId: string, approved: boolean): void {
  const resolve = pendingApprovals.get(transferId)
  if (resolve) {
    pendingApprovals.delete(transferId)
    resolve(approved)
  }
}

export function approvePairingRequest(pairRequestId: string, approved: boolean): void {
  const resolve = pendingPairRequests.get(pairRequestId)
  if (resolve) {
    pendingPairRequests.delete(pairRequestId)
    resolve(approved)
  }
}

export function getOwnDeviceId(): string {
  return deviceId || getDeviceId()
}

export function getOwnDeviceName(): string {
  return deviceName
}

export function listPairedWithStatus(): LanPairedDevice[] {
  return listPaired().map((p) => ({
    deviceId: p.deviceId,
    deviceName: p.deviceName,
    pairedAt: p.pairedAt,
    online: peers.has(p.deviceId),
    peer: peers.get(p.deviceId) ?? null,
  }))
}

export function getPairedDevice(deviceId: string): PairedDevice | undefined {
  return findPairedByDeviceId(deviceId)
}

/** Initiate an outgoing pair with a discovered peer (click-to-pair). */
export async function pairWithPeer(peerId: string): Promise<{ ok: true; deviceId: string; deviceName: string } | { ok: false; error: string }> {
  const peer = peers.get(peerId)
  if (!peer) return { ok: false, error: 'Peer not found' }
  try {
    const body = Buffer.from(JSON.stringify({
      deviceId: getOwnDeviceId(),
      deviceName,
    }))
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: peer.address,
        port: peer.port,
        path: '/pair',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
        timeout: 65_000,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    if (result.status !== 200) {
      try {
        const parsed = JSON.parse(result.body) as { error?: string }
        return { ok: false, error: parsed.error ?? `Server returned ${result.status}` }
      } catch {
        return { ok: false, error: `Server returned ${result.status}` }
      }
    }

    const parsed = JSON.parse(result.body) as {
      accepted: boolean
      pairToken?: string
      deviceId?: string
      deviceName?: string
      error?: string
    }
    if (!parsed.accepted || !parsed.pairToken || !parsed.deviceId) {
      return { ok: false, error: parsed.error ?? 'Pairing not accepted' }
    }

    upsertPaired({
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName ?? peer.deviceName,
      pairToken: parsed.pairToken,
      pairedAt: Date.now(),
    })
    broadcastPairedDevicesChanged()
    return { ok: true, deviceId: parsed.deviceId, deviceName: parsed.deviceName ?? peer.deviceName }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Remove the pair record locally; best-effort notify remote. */
export async function unpairDevice(targetDeviceId: string): Promise<{ ok: boolean; error?: string }> {
  const paired = findPairedByDeviceId(targetDeviceId)
  if (!paired) return { ok: false, error: 'Not paired' }
  const peer = peers.get(targetDeviceId)
  // Best-effort remote notify — ignore failures
  if (peer) {
    try {
      await new Promise<void>((resolve) => {
        const req = http.request({
          hostname: peer.address,
          port: peer.port,
          path: '/pair',
          method: 'DELETE',
          headers: { Authorization: `Bearer ${paired.pairToken}` },
          timeout: 5000,
        }, (res) => { res.resume(); res.on('end', () => resolve()) })
        req.on('error', () => resolve())
        req.on('timeout', () => { req.destroy(); resolve() })
        req.end()
      })
    } catch { /* ignore */ }
  }
  removePaired(targetDeviceId)
  broadcastPairedDevicesChanged()
  return { ok: true }
}

/** Send a notify to a paired peer that a project just changed. */
export async function sendSyncNotify(targetDeviceId: string, projectId: string, updatedAt: number): Promise<boolean> {
  const paired = findPairedByDeviceId(targetDeviceId)
  const peer = peers.get(targetDeviceId)
  if (!paired || !peer) return false
  try {
    const body = Buffer.from(JSON.stringify({ projectId, updatedAt }))
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: peer.address,
        port: peer.port,
        path: '/sync/notify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Authorization: `Bearer ${paired.pairToken}`,
        },
        timeout: 8000,
      }, (res) => { res.resume(); res.on('end', () => resolve()); res.on('error', reject) })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.write(body)
      req.end()
    })
    return true
  } catch (err) {
    logger.warn(`[LAN Sync] notify to ${targetDeviceId} failed: ${err}`)
    return false
  }
}

/** Fetch the catalog from a paired peer (for reconnect-pull). */
export async function fetchSyncCatalog(targetDeviceId: string): Promise<Array<{ projectId: string; updatedAt: number; name?: string }>> {
  const paired = findPairedByDeviceId(targetDeviceId)
  const peer = peers.get(targetDeviceId)
  if (!paired || !peer) return []
  try {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: peer.address,
        port: peer.port,
        path: '/sync/catalog',
        method: 'GET',
        headers: { Authorization: `Bearer ${paired.pairToken}` },
        timeout: 8000,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
    if (result.status !== 200) return []
    return JSON.parse(result.body) as Array<{ projectId: string; updatedAt: number; name?: string }>
  } catch (err) {
    logger.warn(`[LAN Sync] fetchSyncCatalog ${targetDeviceId} failed: ${err}`)
    return []
  }
}

/** Return the peer record for a paired device, if currently online. */
export function getOnlinePeerForPaired(targetDeviceId: string): LanSyncPeer | undefined {
  if (!findPairedByDeviceId(targetDeviceId)) return undefined
  return peers.get(targetDeviceId)
}
