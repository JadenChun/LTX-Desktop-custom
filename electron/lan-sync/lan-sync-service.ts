import crypto from 'crypto'
import dgram from 'dgram'
import http from 'http'
import os from 'os'
import { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { listMcpProjects } from '../mcp-project-store'
import type { LanSyncPeer, LanSyncIncomingRequest } from '../../shared/electron-api-schema'
import { streamProjectBundle, estimateProjectSize } from './project-bundler'

// ── Constants ─────────────────────────────────────────────────────────────────
// Use 239.77.84.88 — private-use administratively-scoped multicast (239.0.0.0/8)
// Avoids conflict with real mDNS at 224.0.0.251 (owned by macOS mDNSResponder)
const MULTICAST_GROUP = '239.77.84.88'
const BEACON_PORT = 35354
const BEACON_INTERVAL_MS = 3000
const PEER_TIMEOUT_MS = 12000 // 4 missed beacons → evict

// ── Module state ──────────────────────────────────────────────────────────────
let enabled = true
const deviceId = crypto.randomUUID()
const deviceName = os.hostname()
let sessionToken = crypto.randomBytes(24).toString('base64url')

let udpSocket: dgram.Socket | null = null
let httpServer: http.Server | null = null
let httpPort: number | null = null
let beaconTimer: NodeJS.Timeout | null = null
let evictTimer: NodeJS.Timeout | null = null

const peers = new Map<string, LanSyncPeer>()
// Map of transferId → resolve function for the approval Promise
const pendingApprovals = new Map<string, (approved: boolean) => void>()

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastPeersChanged(): void {
  const list = Array.from(peers.values())
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-peers-changed', list)
  }
}

function evictStalePeers(): void {
  const now = Date.now()
  let changed = false
  for (const [id, peer] of peers.entries()) {
    if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
      peers.delete(id)
      changed = true
    }
  }
  if (changed) broadcastPeersChanged()
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
function requireAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers['authorization'] ?? ''
  return auth === `Bearer ${sessionToken}`
}

async function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!requireAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  const url = req.url ?? ''

  // GET /projects — list project summaries
  if (req.method === 'GET' && url === '/projects') {
    const projects = listMcpProjects()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(projects))
    return
  }

  // GET /transfer/:projectId — stream project bundle after sender approval
  const transferMatch = url.match(/^\/transfer\/([^/]+)$/)
  if (req.method === 'GET' && transferMatch) {
    const projectId = decodeURIComponent(transferMatch[1])
    const transferId = crypto.randomUUID()

    // Estimate size for progress display
    let estimatedBytes = 0
    try { estimatedBytes = estimateProjectSize(projectId) } catch { /* best-effort */ }

    // Look up project name for the approval dialog
    let projectName = projectId
    try {
      const summaries = listMcpProjects()
      projectName = summaries.find(s => s.id === projectId)?.name ?? projectId
    } catch { /* best-effort */ }

    // Ask the sender's user to approve
    const fromDeviceName = req.headers['x-device-name'] as string | undefined ?? 'Unknown device'
    const incomingRequest: LanSyncIncomingRequest = { transferId, fromDeviceName, projectId, projectName, estimatedBytes }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('lan-sync-incoming-request', incomingRequest)
    }

    // Wait for approval (or 60s timeout)
    const approved = await new Promise<boolean>((resolve) => {
      pendingApprovals.set(transferId, resolve)
      setTimeout(() => {
        if (pendingApprovals.has(transferId)) {
          pendingApprovals.delete(transferId)
          resolve(false)
        }
      }, 60_000)
    })

    if (!approved) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Transfer denied by sender' }))
      return
    }

    // Stream the ZIP
    const abortController = new AbortController()
    req.on('close', () => abortController.abort())

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="project-${projectId}.ltxp"`,
      'X-Ltx-Estimated-Bytes': String(estimatedBytes),
      'X-Transfer-Id': transferId,
      'Transfer-Encoding': 'chunked',
    })

    try {
      await streamProjectBundle(projectId, res, abortController.signal)
    } catch (err) {
      logger.error(`[LAN Sync] bundle stream error: ${err}`)
    }
    res.end()
    return
  }

  res.writeHead(404)
  res.end()
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

    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString()) as Record<string, unknown>
        if (data.type !== 'ltx-announce') return
        if (data.deviceId === deviceId) return // ignore own beacons

        const peerId = data.deviceId as string
        const peer: LanSyncPeer = {
          id: peerId,
          deviceName: (data.deviceName as string) ?? 'Unknown',
          address: (data.address as string) ?? getLocalIp(),
          port: data.port as number,
          lastSeen: Date.now(),
          token: data.token as string,
        }

        // Resolve address from the incoming packet (more reliable than beacon payload)
        const existing = peers.get(peerId)
        const changed = !existing || existing.port !== peer.port || existing.token !== peer.token

        peers.set(peerId, peer)
        if (changed || !existing) broadcastPeersChanged()
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
    // HTTP server must be ready before beaconing so the port is known
    await startHttpServer()
    await startUdpSocket()
    startBeacon()
    evictTimer = setInterval(evictStalePeers, 5000)
    logger.info('[LAN Sync] started')
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

export function approveIncomingTransfer(transferId: string, approved: boolean): void {
  const resolve = pendingApprovals.get(transferId)
  if (resolve) {
    pendingApprovals.delete(transferId)
    resolve(approved)
  }
}
