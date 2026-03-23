import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Asset, AssetTake, ViewType, ProjectTab, Timeline } from '../types/project'
import { createDefaultTimeline } from '../types/project'
import { backendFetch, backendSseUrl } from '../lib/backend'
import { logger } from '../lib/logger'

interface ProjectContextType {
  // Navigation
  currentView: ViewType
  setCurrentView: (view: ViewType) => void
  currentProjectId: string | null
  setCurrentProjectId: (id: string | null) => void
  currentTab: ProjectTab
  setCurrentTab: (tab: ProjectTab) => void
  
  // Projects
  projects: Project[]
  currentProject: Project | null
  createProject: (name: string) => Project
  deleteProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  
  // Assets
  addAsset: (projectId: string, asset: Omit<Asset, 'id' | 'createdAt'>) => Asset
  deleteAsset: (projectId: string, assetId: string) => void
  updateAsset: (projectId: string, assetId: string, updates: Partial<Asset>) => void
  addTakeToAsset: (projectId: string, assetId: string, take: AssetTake) => void
  deleteTakeFromAsset: (projectId: string, assetId: string, takeIndex: number) => void
  setAssetActiveTake: (projectId: string, assetId: string, takeIndex: number) => void
  toggleFavorite: (projectId: string, assetId: string) => void
  
  // Timelines
  addTimeline: (projectId: string, name?: string) => Timeline
  deleteTimeline: (projectId: string, timelineId: string) => void
  renameTimeline: (projectId: string, timelineId: string, name: string) => void
  duplicateTimeline: (projectId: string, timelineId: string) => Timeline | null
  setActiveTimeline: (projectId: string, timelineId: string) => void
  updateTimeline: (projectId: string, timelineId: string, updates: Partial<Pick<Timeline, 'tracks' | 'clips' | 'subtitles'>>) => void
  getActiveTimeline: (projectId: string) => Timeline | null
  
  // Agent import
  importMcpProject: (projectId: string, options?: ImportMcpProjectOptions) => Promise<Project>

  // Navigation helpers
  openProject: (id: string) => void
  goHome: () => void
  openPlayground: () => void
  
  // Cross-view communication (editor → gen space)
  genSpaceEditImageUrl: string | null
  setGenSpaceEditImageUrl: (url: string | null) => void
  genSpaceEditMode: 'image' | 'video' | null
  setGenSpaceEditMode: (mode: 'image' | 'video' | null) => void
  genSpaceAudioUrl: string | null
  setGenSpaceAudioUrl: (url: string | null) => void
  genSpaceRetakeSource: GenSpaceRetakeSource | null
  setGenSpaceRetakeSource: (source: GenSpaceRetakeSource | null) => void
  pendingRetakeUpdate: PendingRetakeUpdate | null
  setPendingRetakeUpdate: (update: PendingRetakeUpdate | null) => void
  genSpaceIcLoraSource: GenSpaceIcLoraSource | null
  setGenSpaceIcLoraSource: (source: GenSpaceIcLoraSource | null) => void
  pendingIcLoraUpdate: PendingIcLoraUpdate | null
  setPendingIcLoraUpdate: (update: PendingIcLoraUpdate | null) => void
}

export interface GenSpaceRetakeSource {
  videoUrl: string
  videoPath: string
  clipId?: string
  assetId?: string
  linkedClipIds?: string[]
  duration?: number
}

export interface PendingRetakeUpdate {
  assetId: string
  clipIds: string[]
  newTakeIndex: number
}

export interface GenSpaceIcLoraSource {
  videoUrl: string
  videoPath: string
  clipId?: string
  assetId?: string
  linkedClipIds?: string[]
}

export interface PendingIcLoraUpdate {
  assetId: string
  clipIds: string[]
  newTakeIndex: number
}

export interface ImportMcpProjectOptions {
  overwrite?: boolean
  createBackup?: boolean
}

const ProjectContext = createContext<ProjectContextType | null>(null)

const STORAGE_KEY = 'ltx-projects'

// Migrate old projects that don't have timelines
function migrateProject(project: Project): Project {
  if (!project.timelines) {
    return {
      ...project,
      timelines: [createDefaultTimeline('Timeline 1')],
      activeTimelineId: undefined, // will be set on first access
    }
  }
  return project
}

// Rebuild a file:// URL from a filesystem path
function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`
}

// Check if a path looks like a real filesystem path (not just a filename)
function isRealPath(p: string): boolean {
  if (!p) return false
  // Has directory separators or starts with a drive letter (Windows) or /
  return p.includes('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)
}

function shouldApprovePath(p?: string | null): p is string {
  if (!p) return false
  const lower = p.toLowerCase()
  if (lower.startsWith('blob:') || lower.startsWith('data:')) return false
  if (lower.startsWith('file://')) return true
  return isRealPath(p)
}

function collectProjectFileAccessPaths(project: Project): string[] {
  const paths = new Set<string>()
  const add = (p?: string | null) => {
    if (shouldApprovePath(p)) paths.add(p)
  }

  for (const asset of project.assets) {
    add(asset.path)
    add(asset.url)
    asset.takes?.forEach(take => {
      add(take.path)
      add(take.url)
    })
  }

  project.timelines?.forEach(timeline => {
    timeline.clips?.forEach(clip => {
      add(clip.importedUrl)
      if (clip.asset) {
        add(clip.asset.path)
        add(clip.asset.url)
        clip.asset.takes?.forEach(take => {
          add(take.path)
          add(take.url)
        })
      }
    })
  })

  return Array.from(paths)
}

// Recover broken blob URLs by rebuilding file:// URLs from stored paths
function recoverAssetUrls(project: Project): Project {
  let changed = false
  const fixedAssets = project.assets.map(asset => {
    // If the URL is a blob: URL and we have a real file path, recover it
    if (asset.url && asset.url.startsWith('blob:') && isRealPath(asset.path)) {
      changed = true
      const fixedUrl = pathToFileUrl(asset.path)
      const fixedTakes = asset.takes?.map(t => ({
        ...t,
        url: t.url.startsWith('blob:') && isRealPath(t.path) ? pathToFileUrl(t.path) : t.url
      }))
      return { ...asset, url: fixedUrl, takes: fixedTakes || asset.takes }
    }
    return asset
  })
  
  if (!changed) return project
  
  // Also fix clip embedded assets and timeline clip references
  const fixedTimelines = project.timelines?.map(tl => ({
    ...tl,
    clips: tl.clips?.map(clip => {
      if (clip.asset?.url?.startsWith('blob:') && isRealPath(clip.asset.path)) {
        return { ...clip, asset: { ...clip.asset, url: pathToFileUrl(clip.asset.path) } }
      }
      return clip
    }) || tl.clips
  }))
  
  return { ...project, assets: fixedAssets, timelines: fixedTimelines || project.timelines }
}

// Repair corrupted trackIndex values (e.g. from subtitle track deletion bug)
function repairTrackIndices(project: Project): Project {
  let changed = false
  const fixedTimelines = project.timelines?.map(tl => {
    const trackCount = tl.tracks?.length || 0
    if (trackCount === 0) return tl
    const fixedClips = tl.clips?.map(clip => {
      if (clip.trackIndex >= trackCount || clip.trackIndex < 0) {
        changed = true
        return { ...clip, trackIndex: Math.max(0, Math.min(trackCount - 1, clip.trackIndex)) }
      }
      return clip
    })
    const fixedSubtitles = tl.subtitles?.map(sub => {
      if (sub.trackIndex >= trackCount || sub.trackIndex < 0) {
        changed = true
        return { ...sub, trackIndex: Math.max(0, Math.min(trackCount - 1, sub.trackIndex)) }
      }
      return sub
    })
    if (!changed) return tl
    return { ...tl, clips: fixedClips || tl.clips, subtitles: fixedSubtitles || tl.subtitles }
  })
  if (!changed) return project
  return { ...project, timelines: fixedTimelines || project.timelines }
}

// Load initial projects from localStorage synchronously
function loadProjectsFromStorage(): Project[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        // Migrate any old projects, then recover broken blob URLs, then repair track indices
        return parsed.map(migrateProject).map(recoverAssetUrls).map(repairTrackIndices)
      }
    }
  } catch (e) {
    logger.error(`Failed to load projects: ${e}`)
  }
  return []
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewType>('home')
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [currentTab, setCurrentTab] = useState<ProjectTab>('video-editor')
  const [genSpaceEditImageUrl, setGenSpaceEditImageUrl] = useState<string | null>(null)
  const [genSpaceEditMode, setGenSpaceEditMode] = useState<'image' | 'video' | null>(null)
  const [genSpaceAudioUrl, setGenSpaceAudioUrl] = useState<string | null>(null)
  const [genSpaceRetakeSource, setGenSpaceRetakeSource] = useState<GenSpaceRetakeSource | null>(null)
  const [pendingRetakeUpdate, setPendingRetakeUpdate] = useState<PendingRetakeUpdate | null>(null)
  const [genSpaceIcLoraSource, setGenSpaceIcLoraSource] = useState<GenSpaceIcLoraSource | null>(null)
  const [pendingIcLoraUpdate, setPendingIcLoraUpdate] = useState<PendingIcLoraUpdate | null>(null)
  // Initialize with data from localStorage
  const [projects, setProjects] = useState<Project[]>(() => loadProjectsFromStorage())
  const isInitializedRef = useRef(false)
  const backupMergeInFlightRef = useRef(false)
  const backupMergeLastAttemptRef = useRef(0)
  const mcpSaveTimersRef = useRef<Map<string, number>>(new Map())
  const mcpSavePendingRef = useRef<Map<string, Project>>(new Map())
  const mcpSaveInFlightRef = useRef<Set<string>>(new Set())
  const lastApprovedPathsSignatureRef = useRef<string>('')
  
  // Mark as initialized after first render
  useEffect(() => {
    isInitializedRef.current = true
  }, [])

  // Sync a single MCP project by ID (fetch full state from backend)
  const syncSingleProject = useCallback(async (projectId: string) => {
    try {
      const pr = await backendFetch(`/api/mcp/projects/${projectId}`)
      if (!pr.ok) return
      const projectData = await pr.json() as Project
      const imported = recoverAssetUrls(migrateProject(projectData))
      imported.mcpLastUpdatedAt = imported.updatedAt

      setProjects(prev => {
        const existing = prev.find(p => p.id === projectId)
        if (!existing) {
          // New project from MCP
          return [imported, ...prev]
        }
        // Check if local edits happened since last sync
        const lastSeen = existing.mcpLastUpdatedAt ?? 0
        if (imported.updatedAt <= lastSeen) return prev

        const backups: Project[] = []
        if (existing.updatedAt > lastSeen) {
          const now = Date.now()
          backups.push({
            ...existing,
            id: `project-${now}-${Math.random().toString(36).substr(2, 9)}`,
            name: `${existing.name} (Local backup)`,
            createdAt: now,
            updatedAt: now,
            mcpLastUpdatedAt: undefined,
            backupOfProjectId: existing.id,
          })
        }
        const replaced = prev.map(p => p.id === projectId ? imported : p)
        return backups.length ? [...backups, ...replaced] : replaced
      })
    } catch (e) {
      logger.info(`MCP sync for ${projectId} failed: ${e}`)
    }
  }, [])

  // Full sync: fetch all MCP project summaries and sync any that are newer
  const syncAllMcpProjects = useCallback(async () => {
    try {
      const resp = await backendFetch('/api/mcp/projects')
      if (!resp.ok) return
      const summaries = await resp.json() as { id: string, updatedAt?: number }[]

      const stored = localStorage.getItem(STORAGE_KEY)
      const existing = stored ? (JSON.parse(stored) as Project[]) : []
      const existingById = new Map(existing.map(p => [p.id, p]))

      for (const summary of summaries) {
        if (!summary?.id) continue
        const local = existingById.get(summary.id)
        const mcpUpdatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
        const lastSeen = local?.mcpLastUpdatedAt ?? 0
        if (local && mcpUpdatedAt <= lastSeen) continue
        await syncSingleProject(summary.id)
      }
    } catch (e) {
      logger.info(`MCP auto-sync skipped: ${e}`)
    }
  }, [syncSingleProject])

  // SSE connection for real-time backend→frontend sync, with polling fallback
  useEffect(() => {
    let eventSource: EventSource | null = null
    let fallbackIntervalId: number | null = null
    let cancelled = false

    const connectSse = async () => {
      if (cancelled) return
      try {
        const sseUrl = await backendSseUrl('/api/mcp/events')
        if (cancelled) return
        eventSource = new EventSource(sseUrl)

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as { type: string; projectId: string; updatedAt: number }
            if (data.type === 'project_updated' && data.projectId) {
              void syncSingleProject(data.projectId)
            }
          } catch {
            // Ignore malformed messages
          }
        }

        eventSource.onopen = () => {
          // SSE connected — stop polling fallback if running
          if (fallbackIntervalId !== null) {
            window.clearInterval(fallbackIntervalId)
            fallbackIntervalId = null
          }
        }

        eventSource.onerror = () => {
          // SSE disconnected — close and try to reconnect after 2s
          eventSource?.close()
          eventSource = null
          // Start polling fallback while SSE is down
          if (fallbackIntervalId === null && !cancelled) {
            fallbackIntervalId = window.setInterval(() => { void syncAllMcpProjects() }, 2000)
          }
          if (!cancelled) {
            window.setTimeout(connectSse, 2000)
          }
        }
      } catch {
        // SSE not available — fall back to polling
        if (fallbackIntervalId === null && !cancelled) {
          fallbackIntervalId = window.setInterval(() => { void syncAllMcpProjects() }, 2000)
        }
        if (!cancelled) {
          window.setTimeout(connectSse, 5000)
        }
      }
    }

    // Do an initial full sync, then connect SSE
    void syncAllMcpProjects()
    void connectSse()

    const onFocus = () => { void syncAllMcpProjects() }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      eventSource?.close()
      if (fallbackIntervalId !== null) window.clearInterval(fallbackIntervalId)
      window.removeEventListener('focus', onFocus)
    }
  }, [syncSingleProject, syncAllMcpProjects])

  // If MCP sync created a local backup, automatically merge it back into the MCP store (one-time recovery).
  useEffect(() => {
    const now = Date.now()
    if (backupMergeInFlightRef.current) return
    if (now - backupMergeLastAttemptRef.current < 1500) return

    const backups = projects.filter(p => p.name.endsWith(' (Local backup)'))
    if (backups.length === 0) return

    const mcpProjects = projects.filter(p => p.mcpLastUpdatedAt !== undefined)
    if (mcpProjects.length === 0) return

    // For each base project, pick the newest backup and overwrite the MCP store with it.
    const candidates: Array<{ backup: Project; target: Project }> = []
    const byTargetId = new Map<string, Project>()

    for (const b of backups) {
      const targetId = b.backupOfProjectId
      const target = targetId ? mcpProjects.find(p => p.id === targetId) : (() => {
        const baseName = b.name.replace(/ \(Local backup\)$/, '')
        return mcpProjects.find(p => p.name === baseName)
      })()
      if (!target) continue
      if (b.updatedAt <= (target.mcpLastUpdatedAt ?? 0)) continue

      const existing = byTargetId.get(target.id)
      if (!existing || (b.updatedAt > existing.updatedAt)) {
        byTargetId.set(target.id, b)
      }
    }

    for (const [targetId, backup] of byTargetId.entries()) {
      const target = mcpProjects.find(p => p.id === targetId)
      if (target) candidates.push({ backup, target })
    }

    if (candidates.length === 0) return

    backupMergeInFlightRef.current = true
    backupMergeLastAttemptRef.current = now

    void (async () => {
      for (const { backup, target } of candidates) {
        try {
          const payload: any = {
            ...backup,
            id: target.id,
            name: target.name,
            createdAt: target.createdAt,
          }
          delete payload.mcpLastUpdatedAt
          delete payload.backupOfProjectId

          const resp = await backendFetch(`/api/mcp/projects/${target.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const saved = await resp.json() as Project
          const serverUpdatedAt = saved.updatedAt

          setProjects(prev => {
            const next = prev
              .filter(p => p.id !== backup.id)
              .map(p => p.id === target.id ? { ...saved, mcpLastUpdatedAt: serverUpdatedAt } : p)
            return next
          })

          logger.info(`Merged local backup into MCP project: ${target.id}`)
        } catch (e) {
          logger.info(`Backup merge failed for ${target.id}: ${e}`)
        }
      }
    })().finally(() => {
      backupMergeInFlightRef.current = false
    })
  }, [projects])

  // Save projects to localStorage when changed (but not on initial load)
  useEffect(() => {
    // Skip saving on initial render to avoid overwriting with stale data
    if (!isInitializedRef.current) return
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
      logger.info(`Projects saved: ${projects.length}`)
    } catch (e) {
      logger.error(`Failed to save projects: ${e}`)
    }
  }, [projects])

  const queueMcpSave = useCallback((projectId: string) => {
    const existingTimer = mcpSaveTimersRef.current.get(projectId)
    if (existingTimer) window.clearTimeout(existingTimer)

    const handle = window.setTimeout(async () => {
      const pending = mcpSavePendingRef.current.get(projectId)
      if (!pending || pending.mcpLastUpdatedAt === undefined) return
      if (mcpSaveInFlightRef.current.has(projectId)) {
        queueMcpSave(projectId)
        return
      }

      const lastSeen = pending.mcpLastUpdatedAt ?? 0
      if (pending.updatedAt <= lastSeen) {
        mcpSavePendingRef.current.delete(projectId)
        return
      }

      mcpSaveInFlightRef.current.add(projectId)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        // Optimistic concurrency: tell the server what version we last saw
        if (lastSeen > 0) {
          headers['If-Match'] = String(lastSeen)
        }
        const resp = await backendFetch(`/api/mcp/projects/${projectId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(pending),
        })
        if (resp.status === 409) {
          // Server has newer version — fetch it and merge
          const serverProject = await resp.json() as Project
          const imported = recoverAssetUrls(migrateProject(serverProject))
          imported.mcpLastUpdatedAt = imported.updatedAt
          setProjects(prev => prev.map(p => p.id === projectId ? imported : p))
          mcpSavePendingRef.current.delete(projectId)
          return
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const saved = await resp.json() as Project
        const serverUpdatedAt = saved.updatedAt

        setProjects(prev => prev.map(p => (
          p.id === projectId
            ? { ...p, updatedAt: serverUpdatedAt, mcpLastUpdatedAt: serverUpdatedAt }
            : p
        )))

        // If no newer local edits happened during the request, clear pending.
        const stillPending = mcpSavePendingRef.current.get(projectId)
        if (stillPending && stillPending.updatedAt <= (serverUpdatedAt ?? stillPending.updatedAt)) {
          mcpSavePendingRef.current.delete(projectId)
        }
      } catch (e) {
        logger.info(`MCP save failed for ${projectId}: ${e}`)
      } finally {
        mcpSaveInFlightRef.current.delete(projectId)
        if (mcpSavePendingRef.current.has(projectId)) queueMcpSave(projectId)
      }
    }, 300)

    mcpSaveTimersRef.current.set(projectId, handle)
  }, [])

  useEffect(() => {
    return () => {
      for (const handle of mcpSaveTimersRef.current.values()) {
        window.clearTimeout(handle)
      }
      mcpSaveTimersRef.current.clear()
    }
  }, [])
  
  const currentProject = projects.find(p => p.id === currentProjectId) || null

  // Keep Electron path approvals in sync with all file-backed project media.
  useEffect(() => {
    if (!currentProject || !window.electronAPI?.approvePaths) return
    const paths = collectProjectFileAccessPaths(currentProject)
    if (paths.length === 0) return

    const sortedPaths = [...paths].sort()
    const signature = sortedPaths.join('\n')
    if (signature === lastApprovedPathsSignatureRef.current) return
    lastApprovedPathsSignatureRef.current = signature

    window.electronAPI.approvePaths(sortedPaths).catch((e) => {
      logger.info(`Failed to approve project paths: ${e}`)
    })
  }, [currentProject?.id, currentProject?.updatedAt])

  const createProject = useCallback((name: string): Project => {
    const defaultTimeline = createDefaultTimeline('Timeline 1')
    const newProject: Project = {
      id: `project-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assets: [],
      timelines: [defaultTimeline],
      activeTimelineId: defaultTimeline.id,
    }
    setProjects(prev => [newProject, ...prev])
    return newProject
  }, [])
  
  const deleteProject = useCallback((id: string) => {
    // Try to delete from the MCP backend (fire and forget)
    void backendFetch(`/api/mcp/projects/${id}`, { method: 'DELETE' })
      .catch((e: any) => logger.info(`Failed to delete project on backend: ${e}`))

    setProjects(prev => prev.filter(p => p.id !== id))
    if (currentProjectId === id) {
      setCurrentProjectId(null)
      setCurrentView('home')
    }
  }, [currentProjectId])
  
  const renameProject = useCallback((id: string, name: string) => {
    setProjects(prev => prev.map(p => 
      p.id === id ? { ...p, name, updatedAt: Date.now() } : p
    ))
  }, [])

  const addAsset = useCallback((projectId: string, assetData: Omit<Asset, 'id' | 'createdAt'>): Asset => {
    const newAsset: Asset = {
      ...assetData,
      id: `asset-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      createdAt: Date.now(),
    }
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? { 
            ...p, 
            assets: [newAsset, ...p.assets],
            updatedAt: Date.now(),
            thumbnail: p.thumbnail || newAsset.thumbnail || newAsset.url,
          } 
        : p
    ))
    return newAsset
  }, [])
  
  const deleteAsset = useCallback((projectId: string, assetId: string) => {
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? { ...p, assets: p.assets.filter(a => a.id !== assetId), updatedAt: Date.now() } 
        : p
    ))
  }, [])
  
  const updateAsset = useCallback((projectId: string, assetId: string, updates: Partial<Asset>) => {
    setProjects(prev => prev.map(p =>
      p.id === projectId
        ? {
            ...p,
            assets: p.assets.map(a =>
              a.id === assetId ? { ...a, ...updates } : a
            ),
            updatedAt: Date.now(),
          }
        : p
    ))
  }, [])

  const addTakeToAsset = useCallback((projectId: string, assetId: string, take: AssetTake) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p
      return {
        ...p,
        assets: p.assets.map(a => {
          if (a.id !== assetId) return a
          // Initialize takes array if it doesn't exist (original asset becomes take 0)
          const existingTakes: AssetTake[] = a.takes || [{
            url: a.url,
            path: a.path,
            thumbnail: a.thumbnail,
            createdAt: a.createdAt,
          }]
          const newTakes = [...existingTakes, take]
          const newIndex = newTakes.length - 1
          return {
            ...a,
            takes: newTakes,
            activeTakeIndex: newIndex,
            // Update the main url/path to the new take
            url: take.url,
            path: take.path,
            thumbnail: take.thumbnail || a.thumbnail,
          }
        }),
        updatedAt: Date.now(),
      }
    }))
  }, [])

  const deleteTakeFromAsset = useCallback((projectId: string, assetId: string, takeIndex: number) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p
      return {
        ...p,
        assets: p.assets.map(a => {
          if (a.id !== assetId || !a.takes || a.takes.length <= 1) return a // Never delete the last take
          const newTakes = a.takes.filter((_, i) => i !== takeIndex)
          // Adjust activeTakeIndex
          let newActiveIdx = a.activeTakeIndex ?? newTakes.length - 1
          if (newActiveIdx >= newTakes.length) newActiveIdx = newTakes.length - 1
          if (newActiveIdx < 0) newActiveIdx = 0
          const activeTake = newTakes[newActiveIdx]
          return {
            ...a,
            takes: newTakes,
            activeTakeIndex: newActiveIdx,
            url: activeTake.url,
            path: activeTake.path,
            thumbnail: activeTake.thumbnail || a.thumbnail,
          }
        }),
        updatedAt: Date.now(),
      }
    }))
  }, [])

  const setAssetActiveTake = useCallback((projectId: string, assetId: string, takeIndex: number) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p
      return {
        ...p,
        assets: p.assets.map(a => {
          if (a.id !== assetId || !a.takes) return a
          const idx = Math.max(0, Math.min(takeIndex, a.takes.length - 1))
          const take = a.takes[idx]
          return {
            ...a,
            activeTakeIndex: idx,
            url: take.url,
            path: take.path,
            thumbnail: take.thumbnail || a.thumbnail,
          }
        }),
        updatedAt: Date.now(),
      }
    }))
  }, [])

  const toggleFavorite = useCallback((projectId: string, assetId: string) => {
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? { 
            ...p, 
            assets: p.assets.map(a => 
              a.id === assetId ? { ...a, favorite: !a.favorite } : a
            ),
            updatedAt: Date.now(),
          } 
        : p
    ))
  }, [])
  
  // --- Timeline CRUD ---
  
  const addTimeline = useCallback((projectId: string, name?: string): Timeline => {
    const project = projects.find(p => p.id === projectId)
    const count = (project?.timelines?.length || 0) + 1
    const newTimeline = createDefaultTimeline(name || `Timeline ${count}`)
    
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? { 
            ...p, 
            timelines: [...(p.timelines || []), newTimeline],
            activeTimelineId: newTimeline.id,
            updatedAt: Date.now(),
          } 
        : p
    ))
    return newTimeline
  }, [projects])
  
  const deleteTimeline = useCallback((projectId: string, timelineId: string) => {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p
      const remaining = (p.timelines || []).filter(t => t.id !== timelineId)
      // Don't allow deleting the last timeline
      if (remaining.length === 0) return p
      return {
        ...p,
        timelines: remaining,
        // If we deleted the active timeline, switch to the first remaining
        activeTimelineId: p.activeTimelineId === timelineId ? remaining[0].id : p.activeTimelineId,
        updatedAt: Date.now(),
      }
    }))
  }, [])
  
  const renameTimeline = useCallback((projectId: string, timelineId: string, name: string) => {
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? {
            ...p,
            timelines: (p.timelines || []).map(t => 
              t.id === timelineId ? { ...t, name } : t
            ),
            updatedAt: Date.now(),
          }
        : p
    ))
  }, [])
  
  const duplicateTimeline = useCallback((projectId: string, timelineId: string): Timeline | null => {
    const project = projects.find(p => p.id === projectId)
    const source = project?.timelines?.find(t => t.id === timelineId)
    if (!source) return null
    
    const newTimeline: Timeline = {
      ...source,
      id: `timeline-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: `${source.name} (copy)`,
      createdAt: Date.now(),
      tracks: source.tracks.map(t => ({ ...t })),
      clips: source.clips.map(c => ({ 
        ...c, 
        id: `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` 
      })),
      subtitles: source.subtitles?.map(s => ({
        ...s,
        id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      })),
    }
    
    setProjects(prev => prev.map(p => 
      p.id === projectId 
        ? { 
            ...p, 
            timelines: [...(p.timelines || []), newTimeline],
            activeTimelineId: newTimeline.id,
            updatedAt: Date.now(),
          }
        : p
    ))
    return newTimeline
  }, [projects])
  
  const setActiveTimeline = useCallback((projectId: string, timelineId: string) => {
    setProjects(prev => prev.map(p => 
      p.id === projectId ? { ...p, activeTimelineId: timelineId } : p
    ))
  }, [])
  
  const updateTimeline = useCallback((projectId: string, timelineId: string, updates: Partial<Pick<Timeline, 'tracks' | 'clips' | 'subtitles'>>) => {
    setProjects(prev => {
      const next = prev.map(p => {
        if (p.id !== projectId) return p
        const nextProject: Project = {
          ...p,
          timelines: (p.timelines || []).map(t =>
            t.id === timelineId ? { ...t, ...updates } : t
          ),
          updatedAt: Date.now(),
        }
        if (p.mcpLastUpdatedAt !== undefined) {
          mcpSavePendingRef.current.set(projectId, nextProject)
        }
        return nextProject
      })
      return next
    })
    queueMcpSave(projectId)
  }, [queueMcpSave])
  
  const getActiveTimeline = useCallback((projectId: string): Timeline | null => {
    const project = projects.find(p => p.id === projectId)
    if (!project || !project.timelines || project.timelines.length === 0) return null
    
    // Find the active timeline, or fall back to the first one
    const active = project.timelines.find(t => t.id === project.activeTimelineId)
    return active || project.timelines[0]
  }, [projects])
  
  const importMcpProject = useCallback(async (projectId: string, options?: ImportMcpProjectOptions): Promise<Project> => {
    const overwrite = options?.overwrite ?? true
    const createBackup = options?.createBackup ?? true

    const resp = await backendFetch(`/api/mcp/projects/${projectId}`)
    if (!resp.ok) throw new Error(`Failed to fetch MCP project: ${resp.status}`)
    const projectData = await resp.json() as Project
    const imported = recoverAssetUrls(migrateProject(projectData))
    imported.mcpLastUpdatedAt = imported.updatedAt
    setProjects(prev => {
      const existingIndex = prev.findIndex(p => p.id === imported.id)
      if (existingIndex === -1) return [imported, ...prev]
      if (!overwrite) return prev

      const next = [...prev]

      if (createBackup) {
        const existing = next[existingIndex]
        const backupId = `project-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const backup: Project = {
          ...existing,
          id: backupId,
          name: `${existing.name} (Backup)`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        next.unshift(backup)
      }

      const replacedIndex = next.findIndex(p => p.id === imported.id)
      if (replacedIndex === -1) next.unshift(imported)
      else next[replacedIndex] = imported

      return next
    })
    return imported
  }, [])

  const openProject = useCallback((id: string) => {
    setCurrentProjectId(id)
    setCurrentView('project')
    setCurrentTab('video-editor')
  }, [])
  
  const goHome = useCallback(() => {
    setCurrentView('home')
    setCurrentProjectId(null)
  }, [])
  
  const openPlayground = useCallback(() => {
    setCurrentView('playground')
  }, [])
  
  return (
    <ProjectContext.Provider value={{
      currentView,
      setCurrentView,
      currentProjectId,
      setCurrentProjectId,
      currentTab,
      setCurrentTab,
      projects,
      currentProject,
      createProject,
      deleteProject,
      renameProject,
      addAsset,
      deleteAsset,
      updateAsset,
      addTakeToAsset,
      deleteTakeFromAsset,
      setAssetActiveTake,
      toggleFavorite,
      addTimeline,
      deleteTimeline,
      renameTimeline,
      duplicateTimeline,
      setActiveTimeline,
      updateTimeline,
      getActiveTimeline,
      importMcpProject,
      openProject,
      goHome,
      openPlayground,
      genSpaceEditImageUrl,
      setGenSpaceEditImageUrl,
      genSpaceEditMode,
      setGenSpaceEditMode,
      genSpaceAudioUrl,
      setGenSpaceAudioUrl,
      genSpaceRetakeSource,
      setGenSpaceRetakeSource,
      pendingRetakeUpdate,
      setPendingRetakeUpdate,
      genSpaceIcLoraSource,
      setGenSpaceIcLoraSource,
      pendingIcLoraUpdate,
      setPendingIcLoraUpdate,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProjects() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error('useProjects must be used within a ProjectProvider')
  }
  return context
}
