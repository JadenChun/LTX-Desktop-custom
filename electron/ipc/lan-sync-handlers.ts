import { handle } from './typed-handle'
import {
  getLanSyncStatus,
  setLanSyncEnabled,
  getLanSyncAutoApprove,
  setLanSyncAutoApprove,
  getKnownPeers,
  approveIncomingTransfer,
  approvePairingRequest,
  refreshDiscovery,
  pairWithPeer,
  unpairDevice,
  listPairedWithStatus,
} from '../lan-sync/lan-sync-service'
import { setProjectSyncEnabled } from '../lan-sync/sync-coordinator'
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

  handle('lanSyncRefresh', () => {
    refreshDiscovery()
  })

  handle('lanSyncGetPeers', () => {
    return getKnownPeers()
  })

  handle('lanSyncPair', async ({ peerId }) => {
    const result = await pairWithPeer(peerId)
    if (!result.ok) return { success: false as const, error: result.error }
    return { success: true as const, deviceId: result.deviceId, deviceName: result.deviceName }
  })

  handle('lanSyncApprovePairing', ({ pairRequestId, approved }) => {
    approvePairingRequest(pairRequestId, approved)
  })

  handle('lanSyncUnpair', async ({ deviceId }) => {
    const result = await unpairDevice(deviceId)
    if (!result.ok) return { success: false as const, error: result.error ?? 'Unknown error' }
    return { success: true as const }
  })

  handle('lanSyncListPaired', () => {
    return listPairedWithStatus().map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      pairedAt: d.pairedAt,
      online: d.online,
      peer: d.peer ?? null,
    }))
  })

  handle('lanSyncGetAutoApprove', () => ({ autoApprove: getLanSyncAutoApprove() }))

  handle('lanSyncSetAutoApprove', ({ autoApprove }) => {
    setLanSyncAutoApprove(autoApprove)
  })

  handle('lanSyncSetProjectSync', ({ projectId, enabled }) => {
    const result = setProjectSyncEnabled(projectId, enabled)
    if (!result.ok) return { success: false as const, error: result.error ?? 'Unknown error' }
    return { success: true as const }
  })
}
