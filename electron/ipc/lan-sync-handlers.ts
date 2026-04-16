import { handle } from './typed-handle'
import {
  getLanSyncStatus,
  setLanSyncEnabled,
  getKnownPeers,
  approveIncomingTransfer,
} from '../lan-sync/lan-sync-service'
import { downloadProject, cancelTransfer } from '../lan-sync/transfer-manager'

export function registerLanSyncHandlers(): void {
  handle('lanSyncGetStatus', () => getLanSyncStatus())

  handle('lanSyncSetEnabled', ({ enabled }) => {
    setLanSyncEnabled(enabled)
  })

  handle('lanSyncListRemoteProjects', async ({ peerId }) => {
    const peer = getKnownPeers().find(p => p.id === peerId)
    if (!peer) throw new Error(`Peer not found: ${peerId}`)
    const resp = await fetch(`http://${peer.address}:${peer.port}/projects`, {
      headers: { Authorization: `Bearer ${peer.token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) throw new Error(`Remote returned ${resp.status}`)
    return resp.json() as Promise<unknown>
  })

  handle('lanSyncStartTransfer', ({ peerId, projectId, newProjectId, newProjectName }) => {
    const peer = getKnownPeers().find(p => p.id === peerId)
    if (!peer) return { success: false as const, error: 'Peer not found or disconnected' }
    try {
      const overrides = (newProjectId ?? newProjectName) ? { newProjectId, newProjectName } : undefined
      const transferId = downloadProject(peer, projectId, overrides)
      return { success: true as const, transferId }
    } catch (e) {
      return { success: false as const, error: String(e) }
    }
  })

  handle('lanSyncCancelTransfer', ({ transferId }) => {
    cancelTransfer(transferId)
  })

  handle('lanSyncApproveIncoming', ({ transferId, approved }) => {
    approveIncomingTransfer(transferId, approved)
  })
}
