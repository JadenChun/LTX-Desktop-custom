import { useEffect, useState } from 'react'
import { X, Download, CheckCircle, AlertCircle, Loader2, Film } from 'lucide-react'
import { Button } from './ui/button'
import { useLanSync, type LanSyncPeer } from '../hooks/use-lan-sync'
import { useProjects } from '../contexts/ProjectContext'

interface RemoteProjectSummary {
  id: string
  name?: string
  assetCount: number
  clipCount: number
  updatedAt?: number
}

type ConflictResolution = 'replace' | 'keep-both'

interface LanSyncModalProps {
  peer: LanSyncPeer
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`.replace(/^0\./, '').replace('0 GB', `${Math.round(bytes / (1024 * 1024))} MB`)
}

export function LanSyncModal({ peer, onClose }: LanSyncModalProps) {
  const { listRemoteProjects, startTransfer, cancelTransfer, activeTransfers } = useLanSync()
  const { projects } = useProjects()

  const [remoteProjects, setRemoteProjects] = useState<RemoteProjectSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [resolutions, setResolutions] = useState<Map<string, ConflictResolution>>(new Map())
  // Map projectId → transferId for in-progress transfers
  const [projectTransfers, setProjectTransfers] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    listRemoteProjects(peer.id)
      .then(data => { if (!cancelled) setRemoteProjects(data as RemoteProjectSummary[]) })
      .catch(err => { if (!cancelled) setLoadError(String(err)) })
    return () => { cancelled = true }
  }, [peer.id, listRemoteProjects])

  function getTransferForProject(projectId: string) {
    const transferId = projectTransfers.get(projectId)
    if (!transferId) return null
    return activeTransfers.get(transferId) ?? null
  }

  async function handlePull(project: RemoteProjectSummary) {
    const localExists = projects.some(p => p.id === project.id)
    const resolution = resolutions.get(project.id) ?? 'replace'

    let newProjectId: string | undefined
    let newProjectName: string | undefined
    if (localExists && resolution === 'keep-both') {
      newProjectId = `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      newProjectName = `${project.name ?? 'Project'} (from ${peer.deviceName})`
    }

    const result = await startTransfer(peer.id, project.id, { newProjectId, newProjectName })
    if (result.success) {
      setProjectTransfers(prev => new Map(prev).set(project.id, result.transferId))
    }
  }

  function handleCancel(projectId: string) {
    const transferId = projectTransfers.get(projectId)
    if (transferId) cancelTransfer(transferId)
    setProjectTransfers(prev => { const n = new Map(prev); n.delete(projectId); return n })
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-lg shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-base font-semibold text-white">{peer.deviceName}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">Pull projects to this device</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[60vh] overflow-y-auto space-y-3">
          {loadError && (
            <div className="flex items-center gap-2 text-red-400 text-sm py-4">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>Could not load projects: {loadError}</span>
            </div>
          )}

          {!remoteProjects && !loadError && (
            <div className="flex items-center gap-2 text-zinc-500 text-sm py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading projects...</span>
            </div>
          )}

          {remoteProjects?.length === 0 && (
            <p className="text-zinc-500 text-sm py-4 text-center">No projects on this device.</p>
          )}

          {remoteProjects?.map(project => {
            const transfer = getTransferForProject(project.id)
            const localExists = projects.some(p => p.id === project.id)
            const resolution = resolutions.get(project.id) ?? 'replace'
            const isActive = !!transfer && transfer.phase !== 'complete' && transfer.phase !== 'error'
            const isDone = transfer?.phase === 'complete'
            const isError = transfer?.phase === 'error'

            const progressPct = transfer && transfer.totalBytes > 0
              ? Math.round((transfer.bytesReceived / transfer.totalBytes) * 100)
              : null

            return (
              <div key={project.id} className="bg-zinc-800 rounded-lg p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Film className="h-5 w-5 text-zinc-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{project.name ?? 'Untitled'}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {project.assetCount} asset{project.assetCount !== 1 ? 's' : ''} · {project.clipCount} clip{project.clipCount !== 1 ? 's' : ''}
                    </p>
                  </div>

                  {/* Action button */}
                  {isDone && (
                    <div className="flex items-center gap-1.5 text-green-400 text-xs font-medium flex-shrink-0">
                      <CheckCircle className="h-4 w-4" />
                      Done
                    </div>
                  )}
                  {isError && (
                    <div className="flex items-center gap-1.5 text-red-400 text-xs flex-shrink-0">
                      <AlertCircle className="h-4 w-4" />
                      Failed
                    </div>
                  )}
                  {isActive && (
                    <button
                      onClick={() => handleCancel(project.id)}
                      className="text-xs text-zinc-400 hover:text-white transition-colors flex-shrink-0"
                    >
                      Cancel
                    </button>
                  )}
                  {!isActive && !isDone && (
                    <Button
                      onClick={() => handlePull(project)}
                      className="bg-blue-600 hover:bg-blue-500 h-8 px-3 text-xs flex-shrink-0"
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Pull
                    </Button>
                  )}
                </div>

                {/* Conflict resolution selector */}
                {localExists && !isActive && !isDone && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-500">Already on this device:</span>
                    <select
                      value={resolution}
                      onChange={e => setResolutions(prev => new Map(prev).set(project.id, e.target.value as ConflictResolution))}
                      className="bg-zinc-700 border border-zinc-600 text-zinc-300 rounded px-2 py-1 text-xs"
                    >
                      <option value="replace">Replace local</option>
                      <option value="keep-both">Keep both</option>
                    </select>
                  </div>
                )}

                {/* Progress bar */}
                {isActive && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-zinc-500">
                      <span>{transfer.phase === 'extracting' ? 'Extracting...' : `Downloading${progressPct !== null ? ` ${progressPct}%` : '...'}`}</span>
                      {transfer.totalBytes > 0 && (
                        <span>{formatBytes(transfer.bytesReceived)} / {formatBytes(transfer.totalBytes)}</span>
                      )}
                    </div>
                    <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-300"
                        style={{ width: transfer.phase === 'extracting' ? '100%' : `${progressPct ?? 0}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Error message */}
                {isError && transfer.errorMessage && (
                  <p className="text-xs text-red-400">{transfer.errorMessage}</p>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-zinc-800">
          <p className="text-xs text-zinc-600">
            Both devices must approve the transfer. The sender will see a confirmation dialog.
          </p>
        </div>
      </div>
    </div>
  )
}
