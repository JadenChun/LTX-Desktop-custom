/**
 * Sync coordinator — the glue between project storage and LAN peers.
 *
 * Responsibilities:
 *  - Watch `mcp-project-changed` events. When a LOCAL change lands on a
 *    project that has `syncedWith` paired devices, notify each online peer.
 *  - Receive `/sync/notify` pings from peers and pull if the remote copy is
 *    newer than ours.
 *  - When a paired peer comes online (UDP beacon), fetch their `/sync/catalog`
 *    and pull anything newer.
 *
 * Loop prevention: events with `source === 'remote-sync'` are ignored (those
 * are broadcasts from transfer-manager after installing an incoming project).
 */

import { logger } from '../logger'
import {
  broadcast,
  getMcpProject,
  listMcpProjects,
  onMcpProjectChange,
  putMcpProject,
  type McpProjectChangeEvent,
} from '../mcp-project-store'
import {
  fetchSyncCatalog,
  getOnlinePeerForPaired,
  listPairedWithStatus,
  onPairedPeerOnline,
  onSyncNotify,
  sendSyncNotify,
  type SyncNotifyEvent,
  type PairedPeerOnlineEvent,
} from './lan-sync-service'
import { downloadProject } from './transfer-manager'

const unsubscribers: Array<() => void> = []

/** Read the `syncedWith` array from a project JSON file (defensive). */
function readSyncedWith(projectId: string): string[] {
  try {
    const project = getMcpProject(projectId)
    const raw = project.syncedWith
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

function getLocalUpdatedAt(projectId: string): number {
  try {
    const project = getMcpProject(projectId)
    return typeof project.updatedAt === 'number' ? project.updatedAt : 0
  } catch {
    return 0
  }
}

/** Fan-out a local change to all paired online peers that sync this project. */
function handleLocalChange(event: McpProjectChangeEvent): void {
  if (event.source === 'remote-sync') return
  if (event.kind !== 'updated') return

  const syncedWith = readSyncedWith(event.projectId)
  if (syncedWith.length === 0) return

  const updatedAt = event.updatedAt ?? getLocalUpdatedAt(event.projectId)

  for (const targetDeviceId of syncedWith) {
    const peer = getOnlinePeerForPaired(targetDeviceId)
    if (!peer) continue // offline — will catch up on reconnect
    void sendSyncNotify(targetDeviceId, event.projectId, updatedAt).catch((err) => {
      logger.warn(`[sync-coordinator] notify ${targetDeviceId} failed: ${err}`)
    })
  }
}

/** Pull if the incoming notify is newer than our copy (or forced). */
function handleIncomingNotify(event: SyncNotifyEvent): void {
  const peer = getOnlinePeerForPaired(event.fromDeviceId)
  if (!peer) {
    logger.warn(`[sync-coordinator] notify from ${event.fromDeviceId} but peer is offline`)
    return
  }

  const localUpdatedAt = getLocalUpdatedAt(event.projectId)
  if (!event.forceFullSync && event.updatedAt <= localUpdatedAt) {
    // We already have the same or newer. Nothing to do.
    return
  }

  logger.info(`[sync-coordinator] pulling ${event.projectId} from ${event.fromDeviceId} (remote=${event.updatedAt}, local=${localUpdatedAt}, force=${event.forceFullSync ?? false})`)
  try {
    downloadProject(peer, event.projectId, { triggerReason: 'push' })
  } catch (err) {
    logger.error(`[sync-coordinator] pull failed: ${err}`)
  }
}

/** When a paired peer comes online, ask for its catalog and pull newer projects. */
function handlePairedPeerOnline(event: PairedPeerOnlineEvent): void {
  void (async () => {
    try {
      const catalog = await fetchSyncCatalog(event.deviceId)
      for (const entry of catalog) {
        const localUpdatedAt = getLocalUpdatedAt(entry.projectId)
        if (entry.updatedAt > localUpdatedAt) {
          const peer = getOnlinePeerForPaired(event.deviceId)
          if (!peer) return
          logger.info(`[sync-coordinator] reconnect-pull ${entry.projectId} from ${event.deviceId}`)
          downloadProject(peer, entry.projectId, { triggerReason: 'pull' })
        }
      }

      // Conversely, notify them about projects we have newer than theirs.
      const remoteMap = new Map(catalog.map((e) => [e.projectId, e.updatedAt]))
      for (const summary of listMcpProjects()) {
        const syncedWith = readSyncedWith(summary.id)
        if (!syncedWith.includes(event.deviceId)) continue
        const localUpdatedAt = summary.updatedAt ?? 0
        const remoteUpdatedAt = remoteMap.get(summary.id) ?? 0
        if (localUpdatedAt > remoteUpdatedAt) {
          void sendSyncNotify(event.deviceId, summary.id, localUpdatedAt)
        }
      }
    } catch (err) {
      logger.warn(`[sync-coordinator] reconnect handler failed: ${err}`)
    }
  })()
}

export function startSyncCoordinator(): void {
  unsubscribers.push(onMcpProjectChange(handleLocalChange))
  unsubscribers.push(onSyncNotify(handleIncomingNotify))
  unsubscribers.push(onPairedPeerOnline(handlePairedPeerOnline))
  logger.info('[sync-coordinator] started')
}

export function stopSyncCoordinator(): void {
  for (const unsub of unsubscribers) { try { unsub() } catch { /* ignore */ } }
  unsubscribers.length = 0
  logger.info('[sync-coordinator] stopped')
}

/**
 * Toggle sync on a project for all currently-paired devices.
 * Mutates the project's `syncedWith` field and writes it back.
 */
export function setProjectSyncEnabled(projectId: string, enabled: boolean): { ok: boolean; error?: string } {
  let project: Record<string, unknown>
  try { project = getMcpProject(projectId) } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const paired = listPairedWithStatus()
  const targets = paired.map((p) => p.deviceId)

  const nextSyncedWith = enabled ? targets : []
  const updated = { ...project, syncedWith: nextSyncedWith }

  const result = putMcpProject(projectId, updated)
  if (result.status !== 'ok') {
    return { ok: false, error: `status=${result.status}` }
  }

  // putMcpProject suppresses its own watcher-originated broadcast via ignoredWrites,
  // so emit manually. Use source='remote-sync' so handleLocalChange doesn't send a
  // second (regular) notify — we send the force-push notifies directly below.
  const updatedAtRaw = result.project ? result.project['updatedAt'] : undefined
  const updatedAt = typeof updatedAtRaw === 'number' ? updatedAtRaw : Date.now()
  broadcast({ kind: 'updated', projectId, updatedAt, source: 'remote-sync' })

  // When enabling sync, force-push to every online paired peer so the receiver
  // pulls regardless of its local updatedAt (fixes first-sync after pairing).
  if (enabled) {
    for (const targetDeviceId of targets) {
      void sendSyncNotify(targetDeviceId, projectId, updatedAt, true).catch((err) => {
        logger.warn(`[sync-coordinator] force-notify ${targetDeviceId} failed: ${err}`)
      })
    }
  }
  return { ok: true }
}
