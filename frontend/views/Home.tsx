import { useMemo, useState } from 'react'
import { Plus, Folder, MoreVertical, Trash2, Pencil, Settings, Wifi, RefreshCw, Link2, Link2Off } from 'lucide-react'
import { useProjects } from '../contexts/ProjectContext'
import { LtxLogo } from '../components/LtxLogo'
import { Button } from '../components/ui/button'
import { pathToFileUrl } from '../lib/file-url'
import { useLanSync, type LanSyncPeer } from '../hooks/use-lan-sync'
import { LanSyncModal } from '../components/LanSyncModal'
import { ProjectSyncToggle } from '../components/ProjectSyncToggle'
import type { Project } from '../types/project'

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function ProjectCard({ project, onOpen, onDelete, onRename }: {
  project: Project
  onOpen: () => void
  onDelete: () => void
  onRename: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  const [imgError, setImgError] = useState(false)
  
  // Keep existing representative selection logic: prefer first image, else first asset.
  const representativeAsset = project.assets.find(a => a.type === 'image') || project.assets[0] || null
  const representativeUrl = representativeAsset?.path ? pathToFileUrl(representativeAsset.path) : null
  const representativeBigThumbnailUrl = representativeAsset?.bigThumbnailPath
    ? pathToFileUrl(representativeAsset.bigThumbnailPath)
    : null

  return (
    <div
      className="group relative bg-zinc-900 rounded-lg overflow-hidden border border-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer"
      onClick={onOpen}
    >
      {/* Thumbnail */}
      <div className="aspect-video bg-zinc-800 flex items-center justify-center relative overflow-hidden">
        {representativeAsset && !imgError ? (
          representativeAsset.type === 'video' ? (
            representativeBigThumbnailUrl ? (
              <img
                src={representativeBigThumbnailUrl}
                alt={project.name}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            ) : representativeUrl ? (
              <video
                src={representativeUrl}
                className="w-full h-full object-cover"
                muted
                preload="metadata"
                onError={() => setImgError(true)}
              />
            ) : (
              <Folder className="h-12 w-12 text-zinc-600" />
            )
          ) : representativeUrl ? (
            <img
              src={representativeUrl}
              alt={project.name}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <Folder className="h-12 w-12 text-zinc-600" />
          )
        ) : (
          <Folder className="h-12 w-12 text-zinc-600" />
        )}
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      
      {/* Info */}
      <div className="p-3">
        <h3 className="font-medium text-white truncate">{project.name}</h3>
        <p className="text-xs text-zinc-500 mt-1">{formatDate(project.updatedAt)}</p>
      </div>
      
      {/* Sync toggle — always visible when paired devices exist */}
      <div className="absolute top-2 left-2">
        <ProjectSyncToggle projectId={project.id} syncedWith={project.syncedWith} />
      </div>

      {/* Menu button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          setShowMenu(!showMenu)
        }}
        className="absolute top-2 right-2 p-1.5 rounded bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
      >
        <MoreVertical className="h-4 w-4 text-white" />
      </button>
      
      {/* Dropdown menu */}
      {showMenu && (
        <div 
          className="absolute top-10 right-2 bg-zinc-800 rounded-lg shadow-lg border border-zinc-700 py-1 z-10 min-w-[120px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { onRename(); setShowMenu(false) }}
            className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
          >
            <Pencil className="h-4 w-4" />
            Rename
          </button>
          <button
            onClick={() => { onDelete(); setShowMenu(false) }}
            className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-700 flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

export function Home() {
  const { projects, createProject, deleteProject, renameProject, openProject } = useProjects()
  const {
    peers,
    pairedDevices,
    pairingRequest,
    enabled,
    refresh,
    pairDevice,
    approvePairing,
    unpairDevice,
  } = useLanSync()
  const [selectedPeer, setSelectedPeer] = useState<LanSyncPeer | null>(null)
  const [pairingInFlight, setPairingInFlight] = useState<string | null>(null)
  const [pairedMenuOpen, setPairedMenuOpen] = useState<string | null>(null)

  // Nearby = online peers NOT currently paired
  const pairedIds = useMemo(() => new Set(pairedDevices.map(d => d.deviceId)), [pairedDevices])
  const unpairedPeers = useMemo(() => peers.filter(p => !pairedIds.has(p.id)), [peers, pairedIds])

  const handlePair = async (peer: LanSyncPeer) => {
    setPairingInFlight(peer.id)
    try {
      const result = await pairDevice(peer.id)
      if (!result.success) alert(`Pairing failed: ${result.error}`)
    } finally {
      setPairingInFlight(null)
    }
  }

  const handleUnpair = async (deviceId: string) => {
    setPairedMenuOpen(null)
    if (!confirm('Unpair this device?')) return
    await unpairDevice(deviceId)
  }
  const [isCreating, setIsCreating] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const handleCreateProject = () => {
    if (newProjectName.trim()) {
      const project = createProject(newProjectName.trim())
      setNewProjectName('')
      setIsCreating(false)
      openProject(project.id)
    }
  }
  
  const handleRenameProject = (id: string, currentName: string) => {
    setRenamingId(id)
    setRenameValue(currentName)
  }
  
  const submitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameProject(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('open-settings'))
  }
  
  return (
    <div className="h-screen bg-background flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-zinc-800 flex flex-col">
        <div className="p-6">
          <LtxLogo className="h-6 w-auto text-white" />
        </div>
        
        <nav className="flex-1 px-3">
          <button className="w-full px-3 py-2 rounded-lg bg-zinc-800 text-white text-left text-sm font-medium flex items-center gap-2">
            <Folder className="h-4 w-4" />
            Home
          </button>
          
          {projects.length > 0 && (
            <div className="mt-6">
              <h4 className="px-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                Recent Projects
              </h4>
              {projects.slice(0, 5).map(project => (
                <button
                  key={project.id}
                  onClick={() => openProject(project.id)}
                  className="w-full px-3 py-2 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white text-left text-sm flex items-center gap-2 transition-colors truncate"
                >
                  <Folder className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">{project.name}</span>
                </button>
              ))}
            </div>
          )}

          {pairedDevices.length > 0 && (
            <div className="mt-6">
              <div className="px-3 mb-2">
                <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Link2 className="h-3 w-3" />
                  Paired
                </h4>
              </div>
              {pairedDevices.map(device => (
                <div
                  key={device.deviceId}
                  className="group relative w-full px-3 py-2 rounded-lg text-zinc-400 hover:bg-zinc-800 text-sm flex items-center gap-2"
                >
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${device.online ? 'bg-green-500' : 'bg-zinc-600'}`}
                  />
                  <span className="truncate flex-1" title={device.deviceName}>{device.deviceName}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setPairedMenuOpen(pairedMenuOpen === device.deviceId ? null : device.deviceId)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-300 transition-colors"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                  {pairedMenuOpen === device.deviceId && (
                    <div className="absolute right-2 top-9 bg-zinc-800 rounded-lg shadow-lg border border-zinc-700 py-1 z-10 min-w-[120px]">
                      <button
                        onClick={() => handleUnpair(device.deviceId)}
                        className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-zinc-700 flex items-center gap-2"
                      >
                        <Link2Off className="h-3.5 w-3.5" />
                        Unpair
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-6">
            <div className="px-3 mb-2 flex items-center justify-between">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
                <Wifi className="h-3 w-3" />
                Nearby
              </h4>
              {enabled && (
                <button
                  onClick={refresh}
                  title="Refresh nearby devices"
                  className="text-zinc-600 hover:text-zinc-400 transition-colors"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
            </div>
            {!enabled ? (
              <p className="px-3 text-xs text-zinc-600">Disabled in Settings</p>
            ) : unpairedPeers.length === 0 ? (
              <p className="px-3 text-xs text-zinc-500 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse flex-shrink-0" />
                Looking for devices...
              </p>
            ) : (
              unpairedPeers.map(peer => (
                <div
                  key={peer.id}
                  className="w-full px-3 py-2 rounded-lg text-zinc-400 hover:bg-zinc-800 text-sm flex items-center gap-2"
                >
                  <Wifi className="h-4 w-4 flex-shrink-0 text-blue-400" />
                  <button
                    onClick={() => setSelectedPeer(peer)}
                    className="truncate flex-1 text-left hover:text-white transition-colors"
                    title={peer.deviceName}
                  >
                    {peer.deviceName}
                  </button>
                  <button
                    onClick={() => handlePair(peer)}
                    disabled={pairingInFlight === peer.id}
                    className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-zinc-700 disabled:text-zinc-400 transition-colors"
                  >
                    {pairingInFlight === peer.id ? '…' : 'Pair'}
                  </button>
                </div>
              ))
            )}
          </div>
        </nav>
        
        <div className="p-4 border-t border-zinc-800 space-y-2">
          <button
            onClick={openSettings}
            className="w-full px-3 py-2 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-white text-left text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>
          <button
            onClick={() => setIsCreating(true)}
            className="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      </aside>
      
      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {/* Header Banner with video background */}
        <div className="relative h-72 overflow-hidden">
          <video
            src="./hero-video.mp4"
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
          />
          {/* Dark overlay for text readability */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-black/10" />
          <div className="absolute bottom-6 left-8 z-10">
            <h1 className="text-3xl font-bold text-white mb-2 drop-shadow-lg">LTX Desktop</h1>
            <p className="text-zinc-200 drop-shadow-md">Create and manage your video projects</p>
          </div>
        </div>
        
        {/* Projects Grid */}
        <div className="p-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-white">Projects</h2>
          </div>
          
          {projects.length === 0 ? (
            <div className="text-center py-16">
              <Folder className="h-16 w-16 text-zinc-700 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-zinc-400 mb-2">No projects yet</h3>
              <p className="text-zinc-500 mb-6">Create your first project to get started</p>
              <Button 
                onClick={() => setIsCreating(true)}
                className="bg-blue-600 hover:bg-blue-500"
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Project
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {projects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => openProject(project.id)}
                  onDelete={() => {
                    if (confirm(`Delete "${project.name}"?`)) {
                      deleteProject(project.id)
                    }
                  }}
                  onRename={() => handleRenameProject(project.id, project.name)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
      
      {/* Create Project Modal */}
      {isCreating && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-xl p-6 w-full max-w-md border border-zinc-800">
            <h2 className="text-xl font-semibold text-white mb-4">Create New Project</h2>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Project name"
              className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
            />
            <div className="flex gap-3 mt-6">
              <Button
                variant="outline"
                onClick={() => { setIsCreating(false); setNewProjectName('') }}
                className="flex-1 border-zinc-700"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim()}
                className="flex-1 bg-blue-600 hover:bg-blue-500"
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      )}
      
      {/* LAN Sync Modal */}
      {selectedPeer && (
        <LanSyncModal
          peer={selectedPeer}
          onClose={() => setSelectedPeer(null)}
        />
      )}

      {/* Incoming pairing request */}
      {pairingRequest && (
        <div className="fixed bottom-6 right-6 z-[80] w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <Link2 className="h-4 w-4 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white leading-tight">Pair with this device?</p>
              <p className="text-xs text-zinc-400 mt-1 leading-snug">
                <span className="text-zinc-200">{pairingRequest.fromDeviceName}</span> wants to pair.
                Paired devices can sync projects automatically.
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => approvePairing(pairingRequest.pairRequestId, false)}
              className="flex-1 h-8 text-xs border-zinc-700 text-zinc-400"
            >
              Deny
            </Button>
            <Button
              onClick={() => approvePairing(pairingRequest.pairRequestId, true)}
              className="flex-1 h-8 text-xs bg-blue-600 hover:bg-blue-500"
            >
              Pair
            </Button>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renamingId && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-zinc-900 rounded-xl p-6 w-full max-w-md border border-zinc-800">
            <h2 className="text-xl font-semibold text-white mb-4">Rename Project</h2>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Project name"
              className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-white placeholder:text-zinc-500 focus:outline-none focus:border-blue-500"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && submitRename()}
            />
            <div className="flex gap-3 mt-6">
              <Button
                variant="outline"
                onClick={() => { setRenamingId(null); setRenameValue('') }}
                className="flex-1 border-zinc-700"
              >
                Cancel
              </Button>
              <Button
                onClick={submitRename}
                disabled={!renameValue.trim()}
                className="flex-1 bg-blue-600 hover:bg-blue-500"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
