import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Button } from './ui/button'
import type { LanSyncIncomingRequest } from '../../shared/electron-api-schema'

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024 * 1024) return ` (~${Math.round(bytes / 1024)} KB)`
  if (bytes < 1024 * 1024 * 1024) return ` (~${Math.round(bytes / (1024 * 1024))} MB)`
  return ` (~${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB)`
}

export function LanSyncIncomingDialog() {
  const [requests, setRequests] = useState<LanSyncIncomingRequest[]>([])

  useEffect(() => {
    const unsub = window.electronAPI.onLanSyncIncomingRequest(request => {
      setRequests(prev => [...prev, request])
    })
    return unsub
  }, [])

  function respond(transferId: string, approved: boolean) {
    window.electronAPI.lanSyncApproveIncoming({ transferId, approved }).catch(() => {})
    setRequests(prev => prev.filter(r => r.transferId !== transferId))
  }

  if (requests.length === 0) return null

  return (
    <>
      {requests.map(req => (
        <div key={req.transferId} className="fixed bottom-6 right-6 z-[70] w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <Download className="h-4 w-4 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white leading-tight">Incoming transfer request</p>
              <p className="text-xs text-zinc-400 mt-1 leading-snug">
                <span className="text-zinc-200">{req.fromDeviceName}</span> wants to pull{' '}
                <span className="text-zinc-200">"{req.projectName}"</span>
                {formatBytes(req.estimatedBytes)}
              </p>
            </div>
            <button
              onClick={() => respond(req.transferId, false)}
              className="flex-shrink-0 text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => respond(req.transferId, false)}
              className="flex-1 h-8 text-xs border-zinc-700 text-zinc-400"
            >
              Deny
            </Button>
            <Button
              onClick={() => respond(req.transferId, true)}
              className="flex-1 h-8 text-xs bg-blue-600 hover:bg-blue-500"
            >
              Allow
            </Button>
          </div>
        </div>
      ))}
    </>
  )
}
