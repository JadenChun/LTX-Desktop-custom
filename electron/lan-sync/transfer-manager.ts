import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { putMcpProject, broadcast } from '../mcp-project-store'
import { extractProjectBundle } from './project-extractor'
import type { LanSyncPeer, LanSyncProgressEvent } from '../../shared/electron-api-schema'

// Track active downloads so they can be cancelled
const activeDownloads = new Map<string, { abort: () => void }>()

function emitProgress(event: LanSyncProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lan-sync-progress', event)
  }
}

/**
 * Download a project bundle from a peer, extract it, and install it into the
 * local MCP project store. Emits lan-sync-progress IPC events throughout.
 *
 * @param overrides - Optional { newProjectId, newProjectName } for "keep both" scenario
 */
export function downloadProject(
  peer: LanSyncPeer,
  projectId: string,
  overrides?: { newProjectId?: string; newProjectName?: string },
): string {
  const transferId = crypto.randomUUID()
  const tempFile = path.join(os.tmpdir(), `ltx-transfer-${transferId}.ltxp`)

  let req: http.ClientRequest | null = null
  let aborted = false

  const abort = () => {
    aborted = true
    req?.destroy()
    activeDownloads.delete(transferId)
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch { /* best-effort */ }
  }

  activeDownloads.set(transferId, { abort })

  // Run download asynchronously
  void (async () => {
    try {
      // ── Phase 1: Download ──────────────────────────────────────────────────
      const totalBytes = await new Promise<number>((resolve, reject) => {
        const options: http.RequestOptions = {
          hostname: peer.address,
          port: peer.port,
          path: `/transfer/${encodeURIComponent(projectId)}`,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${peer.token}`,
            'X-Device-Name': os.hostname(),
          },
        }

        req = http.request(options, (res) => {
          if (aborted) { res.destroy(); reject(new Error('aborted')); return }

          if (res.statusCode === 403) {
            reject(new Error('Transfer was denied by the sender.'))
            return
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Server returned ${res.statusCode}`))
            return
          }

          const estimated = parseInt(res.headers['x-ltx-estimated-bytes'] as string ?? '0', 10) || 0
          resolve(estimated)

          const fileStream = fs.createWriteStream(tempFile)
          let bytesReceived = 0

          res.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length
            emitProgress({ transferId, phase: 'downloading', bytesReceived, totalBytes: estimated })
          })

          res.pipe(fileStream)

          fileStream.on('finish', () => {
            emitProgress({ transferId, phase: 'extracting', bytesReceived, totalBytes: estimated })
          })

          fileStream.on('error', reject)
          res.on('error', reject)
        })

        req.on('error', reject)
        req.end()
      })

      if (aborted) return

      // ── Phase 2: Extract ───────────────────────────────────────────────────
      const { projectJson, projectId: finalId } = await extractProjectBundle(tempFile, overrides)

      if (aborted) return

      // ── Phase 3: Install into MCP store ───────────────────────────────────
      const result = putMcpProject(finalId, projectJson)
      if (result.status !== 'ok') {
        throw new Error(`Failed to save project: status=${result.status}`)
      }

      // Bug 1 fix: putMcpProject suppresses its own watcher event via ignoredWrites.
      // Manually broadcast so the frontend's syncSingleProject fires and the project
      // appears in the home grid without requiring an app restart.
      const updatedAt = typeof projectJson['updatedAt'] === 'number' ? projectJson['updatedAt'] : Date.now()
      broadcast({ kind: 'updated', projectId: finalId, updatedAt })

      emitProgress({ transferId, phase: 'complete', bytesReceived: totalBytes, totalBytes })
      logger.info(`[LAN Sync] transfer ${transferId} complete — project "${finalId}" installed`)
    } catch (err) {
      if (aborted) return
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[LAN Sync] transfer ${transferId} failed: ${msg}`)
      emitProgress({ transferId, phase: 'error', bytesReceived: 0, totalBytes: 0, errorMessage: msg })
    } finally {
      activeDownloads.delete(transferId)
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch { /* best-effort */ }
    }
  })()

  return transferId
}

export function cancelTransfer(transferId: string): void {
  activeDownloads.get(transferId)?.abort()
}
