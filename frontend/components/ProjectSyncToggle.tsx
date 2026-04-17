import { useMemo } from 'react'
import { Cloud, CloudOff, Loader2 } from 'lucide-react'
import { useLanSync } from '../hooks/use-lan-sync'

interface Props {
  projectId: string
  syncedWith?: string[]
  /** Render size */
  size?: 'sm' | 'md'
}

/**
 * Cloud-icon toggle that turns LAN sync on/off for this project.
 * Enabling fans out the project to ALL paired devices; disabling clears the list.
 * A loading spinner overlays the icon while a transfer related to this project
 * is in flight.
 */
export function ProjectSyncToggle({ projectId, syncedWith, size = 'sm' }: Props) {
  const { pairedDevices, setProjectSync, activeTransfers } = useLanSync()

  const hasAnyPaired = pairedDevices.length > 0
  const isSynced = (syncedWith?.length ?? 0) > 0

  // Active transfer? We don't thread projectId into the progress event today,
  // so show the spinner whenever ANY transfer is running while this project is
  // synced. (Approximation — improves with a future per-project progress map.)
  const isBusy = useMemo(() => {
    if (!isSynced) return false
    for (const event of activeTransfers.values()) {
      if (event.phase === 'downloading' || event.phase === 'extracting') return true
    }
    return false
  }, [activeTransfers, isSynced])

  if (!hasAnyPaired) return null

  const iconSize = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'
  const buttonSize = size === 'sm' ? 'p-1.5' : 'p-2'

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    void setProjectSync(projectId, !isSynced)
  }

  const title = isSynced
    ? `Syncing to ${pairedDevices.length} paired device${pairedDevices.length === 1 ? '' : 's'}`
    : 'Click to enable LAN sync'

  return (
    <button
      onClick={handleClick}
      title={title}
      className={`${buttonSize} rounded bg-black/50 hover:bg-black/70 transition-colors`}
    >
      {isBusy ? (
        <Loader2 className={`${iconSize} text-blue-400 animate-spin`} />
      ) : isSynced ? (
        <Cloud className={`${iconSize} text-blue-400`} />
      ) : (
        <CloudOff className={`${iconSize} text-zinc-400`} />
      )}
    </button>
  )
}
