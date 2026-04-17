import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { putMcpProject, broadcast } from '../mcp-project-store'
import { getProjectAssetsPath } from '../app-state'
import { installProjectJson } from './project-extractor'
import { findPairedByDeviceId } from './paired-devices'
import type { LanSyncPeer, LanSyncProgressEvent } from '../../shared/electron-api-schema'

// Track active downloads so they can be cancelled
const activeDownloads = new Map<string, { abort: () => void }>()

function emitProgress(event: LanSyncProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-progress', event)
  }
}

/** Fetch a URL over HTTP and return the response body as a Buffer. */
function httpGet(options: http.RequestOptions, onAbort: (cancel: () => void) => void): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    onAbort(() => req.destroy())
    req.on('error', reject)
    req.end()
  })
}

/** Stream a raw file from the sender directly to a destination path. */
function httpGetToFile(
  options: http.RequestOptions,
  destPath: string,
  onAbort: (cancel: () => void) => void,
  onData: (bytes: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Server returned ${res.statusCode} for ${options.path ?? ''}`))
        return
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const fileStream = fs.createWriteStream(destPath)
      res.on('data', (chunk: Buffer) => onData(chunk.length))
      res.pipe(fileStream)
      fileStream.on('finish', resolve)
      fileStream.on('error', reject)
      res.on('error', reject)
    })
    onAbort(() => { req.destroy() })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Download a project from a peer by fetching the manifest then each file
 * individually as raw bytes. No compression or archiving involved.
 *
 * @returns transferId — used to track progress via lan-sync-progress IPC events
 */
export function downloadProject(
  peer: LanSyncPeer,
  projectId: string,
  overrides?: { newProjectId?: string; newProjectName?: string; triggerReason?: 'user' | 'push' | 'pull' },
): string {
  const transferId = crypto.randomUUID()
  let aborted = false
  const cancelFns: Array<() => void> = []

  const abort = () => {
    aborted = true
    for (const cancel of cancelFns) { try { cancel() } catch { /* ignore */ } }
    activeDownloads.delete(transferId)
  }
  activeDownloads.set(transferId, { abort })

  void (async () => {
    try {
      // Prefer pair token when we have a persistent pairing with this peer —
      // the sender recognises it and skips the approval dialog.
      const paired = findPairedByDeviceId(peer.id)
      const authToken = paired?.pairToken ?? peer.token
      const baseOpts: Omit<http.RequestOptions, 'path'> = {
        hostname: peer.address,
        port: peer.port,
        headers: {
          Authorization: `Bearer ${authToken}`,
          'X-Device-Name': os.hostname(),
        },
      }

      // ── Phase 1: Fetch manifest (triggers approval dialog on sender) ───────
      const manifestResp = await httpGet(
        { ...baseOpts, path: `/transfer/${encodeURIComponent(projectId)}` },
        (cancel) => cancelFns.push(cancel),
      )
      if (aborted) return

      if (manifestResp.status === 403) throw new Error('Transfer was denied by the sender.')
      if (manifestResp.status !== 200) throw new Error(`Server returned ${manifestResp.status}`)

      const manifest = JSON.parse(manifestResp.body.toString()) as {
        transferId: string
        project: Record<string, unknown>
        files: Array<{ rel: string; size: number }>
        totalBytes: number
      }

      const { transferId: senderTransferId, project: portableProject, files, totalBytes } = manifest

      emitProgress({ transferId, phase: 'downloading', bytesReceived: 0, totalBytes })

      // ── Phase 2: Download each file directly to its destination path ───────
      const assetsRoot = getProjectAssetsPath()
      let bytesReceived = 0

      for (const file of files) {
        if (aborted) return

        // "assets/proj-id/clip.mp4" → assetsRoot/proj-id/clip.mp4
        const segments = file.rel.startsWith('assets/') ? file.rel.slice('assets/'.length).split('/') : file.rel.split('/')
        const destPath = path.join(assetsRoot, ...segments)

        // Incremental sync heuristic: if a file of identical size already exists,
        // assume it's the same content and skip the download.
        try {
          const existing = fs.statSync(destPath)
          if (existing.isFile() && existing.size === file.size) {
            bytesReceived += file.size
            emitProgress({ transferId, phase: 'downloading', bytesReceived, totalBytes })
            continue
          }
        } catch { /* file doesn't exist — fall through to download */ }

        await httpGetToFile(
          { ...baseOpts, path: `/download/${encodeURIComponent(senderTransferId)}/${encodeURIComponent(file.rel)}` },
          destPath,
          (cancel) => cancelFns.push(cancel),
          (bytes) => {
            bytesReceived += bytes
            emitProgress({ transferId, phase: 'downloading', bytesReceived, totalBytes })
          },
        )
      }

      if (aborted) return

      // ── Phase 3: Install project JSON ──────────────────────────────────────
      emitProgress({ transferId, phase: 'extracting', bytesReceived, totalBytes })

      const { projectJson, projectId: finalId } = installProjectJson(portableProject, overrides)

      const result = putMcpProject(finalId, projectJson)
      if (result.status !== 'ok') throw new Error(`Failed to save project: status=${result.status}`)

      // Manually broadcast so the frontend's syncSingleProject fires.
      // source='remote-sync' so the sync-coordinator doesn't bounce this
      // change back out to the peer we just pulled it from.
      const updatedAt = typeof projectJson['updatedAt'] === 'number' ? projectJson['updatedAt'] : Date.now()
      broadcast({ kind: 'updated', projectId: finalId, updatedAt, source: 'remote-sync' })

      emitProgress({ transferId, phase: 'complete', bytesReceived: totalBytes, totalBytes })
      logger.info(`[LAN Sync] transfer ${transferId} complete — project "${finalId}" installed`)
    } catch (err) {
      if (aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[LAN Sync] transfer ${transferId} failed: ${msg}`)
      emitProgress({ transferId, phase: 'error', bytesReceived: 0, totalBytes: 0, errorMessage: msg })
    } finally {
      activeDownloads.delete(transferId)
    }
  })()

  return transferId
}

export function cancelTransfer(transferId: string): void {
  activeDownloads.get(transferId)?.abort()
}
