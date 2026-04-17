import { useState, useEffect, useCallback } from 'react'
import type {
  LanSyncPeer,
  LanSyncProgressEvent,
  LanPairedDevice,
  LanPairingRequest,
} from '../../shared/electron-api-schema'

export type { LanSyncPeer, LanSyncProgressEvent, LanPairedDevice, LanPairingRequest }

export function useLanSync() {
  const [peers, setPeers] = useState<LanSyncPeer[]>([])
  const [pairedDevices, setPairedDevices] = useState<LanPairedDevice[]>([])
  const [pairingRequest, setPairingRequest] = useState<LanPairingRequest | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [activeTransfers, setActiveTransfers] = useState<Map<string, LanSyncProgressEvent>>(new Map())

  useEffect(() => {
    window.electronAPI.lanSyncGetStatus().then(status => {
      setEnabled(status.enabled)
    }).catch(() => {})

    window.electronAPI.lanSyncListPaired().then(list => {
      setPairedDevices(list)
    }).catch(() => {})

    const unsubPeers = window.electronAPI.onLanSyncPeersChanged(newPeers => {
      setPeers(newPeers)
    })

    const unsubPaired = window.electronAPI.onLanSyncPairedDevicesChanged(list => {
      setPairedDevices(list)
    })

    const unsubPairingReq = window.electronAPI.onLanSyncPairingRequest(req => {
      setPairingRequest(req)
    })

    const unsubProgress = window.electronAPI.onLanSyncProgress(event => {
      setActiveTransfers(prev => {
        const next = new Map(prev)
        next.set(event.transferId, event)
        if (event.phase === 'complete' || event.phase === 'error') {
          setTimeout(() => {
            setActiveTransfers(m => {
              const n = new Map(m)
              n.delete(event.transferId)
              return n
            })
          }, 4000)
        }
        return next
      })
    })

    return () => {
      unsubPeers()
      unsubPaired()
      unsubPairingReq()
      unsubProgress()
    }
  }, [])

  const toggleEnabled = useCallback((value: boolean) => {
    setEnabled(value)
    window.electronAPI.lanSyncSetEnabled({ enabled: value }).catch(() => {})
  }, [])

  const listRemoteProjects = useCallback((peerId: string) => {
    return window.electronAPI.lanSyncListRemoteProjects({ peerId })
  }, [])

  const startTransfer = useCallback((
    peerId: string,
    projectId: string,
    opts?: { newProjectId?: string; newProjectName?: string },
  ) => {
    return window.electronAPI.lanSyncStartTransfer({
      peerId,
      projectId,
      newProjectId: opts?.newProjectId,
      newProjectName: opts?.newProjectName,
    })
  }, [])

  const cancelTransfer = useCallback((transferId: string) => {
    window.electronAPI.lanSyncCancelTransfer({ transferId }).catch(() => {})
  }, [])

  const refresh = useCallback(() => {
    window.electronAPI.lanSyncRefresh().catch(() => {})
  }, [])

  const pairDevice = useCallback((peerId: string) => {
    return window.electronAPI.lanSyncPair({ peerId })
  }, [])

  const approvePairing = useCallback((pairRequestId: string, approved: boolean) => {
    setPairingRequest(prev => (prev?.pairRequestId === pairRequestId ? null : prev))
    return window.electronAPI.lanSyncApprovePairing({ pairRequestId, approved })
  }, [])

  const unpairDevice = useCallback((deviceId: string) => {
    return window.electronAPI.lanSyncUnpair({ deviceId })
  }, [])

  const setProjectSync = useCallback((projectId: string, syncEnabled: boolean) => {
    return window.electronAPI.lanSyncSetProjectSync({ projectId, enabled: syncEnabled })
  }, [])

  return {
    peers,
    pairedDevices,
    pairingRequest,
    enabled,
    activeTransfers,
    toggleEnabled,
    listRemoteProjects,
    startTransfer,
    cancelTransfer,
    refresh,
    pairDevice,
    approvePairing,
    unpairDevice,
    setProjectSync,
  }
}
