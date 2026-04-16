import { useState, useEffect, useCallback } from 'react'
import type { LanSyncPeer, LanSyncProgressEvent } from '../../shared/electron-api-schema'

export type { LanSyncPeer, LanSyncProgressEvent }

export function useLanSync() {
  const [peers, setPeers] = useState<LanSyncPeer[]>([])
  const [enabled, setEnabled] = useState(true)
  const [activeTransfers, setActiveTransfers] = useState<Map<string, LanSyncProgressEvent>>(new Map())

  useEffect(() => {
    window.electronAPI.lanSyncGetStatus().then(status => {
      setEnabled(status.enabled)
    }).catch(() => {})

    const unsubPeers = window.electronAPI.onLanSyncPeersChanged(newPeers => {
      setPeers(newPeers)
    })

    const unsubProgress = window.electronAPI.onLanSyncProgress(event => {
      setActiveTransfers(prev => {
        const next = new Map(prev)
        next.set(event.transferId, event)
        if (event.phase === 'complete' || event.phase === 'error') {
          // Auto-clear after 4s so the UI shows the final state briefly
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

  return { peers, enabled, activeTransfers, toggleEnabled, listRemoteProjects, startTransfer, cancelTransfer, refresh }
}
