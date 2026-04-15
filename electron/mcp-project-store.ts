import { BrowserWindow } from 'electron'
import fs, { type FSWatcher } from 'fs'
import path from 'path'
import { getAppDataDir } from './app-paths'

export interface McpProjectSummary {
  id: string
  name?: string
  createdAt?: number
  updatedAt?: number
  assetCount: number
  clipCount: number
}

export interface McpProjectChangeEvent {
  kind: 'updated' | 'deleted'
  projectId: string
  updatedAt?: number
}

export interface PutMcpProjectResult {
  status: 'ok' | 'conflict' | 'not_found'
  project?: Record<string, unknown>
}

export const MCP_PROJECT_CHANGED_CHANNEL = 'mcp-project-changed'

let watcher: FSWatcher | null = null
let rescanTimer: NodeJS.Timeout | null = null
let reconcileTimer: NodeJS.Timeout | null = null
let lastSnapshot = new Map<string, number>()
const ignoredWrites = new Map<string, number>()
const ignoredDeletes = new Set<string>()

function getProjectsDir(): string {
  const dir = path.join(getAppDataDir(), 'outputs', 'mcp_projects')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function projectPath(projectId: string): string {
  return path.join(getProjectsDir(), `${projectId}.json`)
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readProject(projectId: string): Record<string, unknown> | null {
  return readJsonFile(projectPath(projectId))
}

function summarizeProject(project: Record<string, unknown>): McpProjectSummary | null {
  const id = typeof project.id === 'string' ? project.id : null
  if (!id) return null

  const assets = Array.isArray(project.assets) ? project.assets : []
  const timelines = Array.isArray(project.timelines) ? project.timelines : []
  const clipCount = timelines.reduce((count, timeline) => {
    if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return count
    const timelineRecord = timeline as Record<string, unknown>
    const clips = Array.isArray(timelineRecord.clips) ? timelineRecord.clips.length : 0
    return count + clips
  }, 0)

  return {
    id,
    name: typeof project.name === 'string' ? project.name : undefined,
    createdAt: typeof project.createdAt === 'number' ? project.createdAt : undefined,
    updatedAt: typeof project.updatedAt === 'number' ? project.updatedAt : undefined,
    assetCount: assets.length,
    clipCount,
  }
}

function atomicWriteJson(filePath: string, payload: Record<string, unknown>): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  fs.writeFileSync(tempPath, JSON.stringify(payload))
  fs.renameSync(tempPath, filePath)
}

function takeSnapshot(): Map<string, number> {
  const snapshot = new Map<string, number>()
  for (const entry of fs.readdirSync(getProjectsDir(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const project = readJsonFile(path.join(getProjectsDir(), entry.name))
    if (!project) continue
    const id = typeof project.id === 'string' ? project.id : path.basename(entry.name, '.json')
    const updatedAt = typeof project.updatedAt === 'number' ? project.updatedAt : 0
    snapshot.set(id, updatedAt)
  }
  return snapshot
}

function broadcast(change: McpProjectChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(MCP_PROJECT_CHANGED_CHANNEL, change)
  }
}

function flushRescan(): void {
  rescanTimer = null
  const nextSnapshot = takeSnapshot()

  for (const [projectId, updatedAt] of nextSnapshot.entries()) {
    const previousUpdatedAt = lastSnapshot.get(projectId)
    if (previousUpdatedAt === updatedAt) continue

    const ignoredUpdatedAt = ignoredWrites.get(projectId)
    if (ignoredUpdatedAt !== undefined && updatedAt <= ignoredUpdatedAt) {
      if (updatedAt === ignoredUpdatedAt) ignoredWrites.delete(projectId)
      continue
    }

    ignoredWrites.delete(projectId)
    broadcast({ kind: 'updated', projectId, updatedAt })
  }

  for (const projectId of lastSnapshot.keys()) {
    if (nextSnapshot.has(projectId)) continue
    if (ignoredDeletes.has(projectId)) {
      ignoredDeletes.delete(projectId)
      continue
    }
    ignoredWrites.delete(projectId)
    broadcast({ kind: 'deleted', projectId })
  }

  lastSnapshot = nextSnapshot
}

function scheduleRescan(): void {
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = setTimeout(() => flushRescan(), 120)
}

export function startMcpProjectWatcher(): void {
  if (watcher) return
  getProjectsDir()
  lastSnapshot = takeSnapshot()
  watcher = fs.watch(getProjectsDir(), () => {
    scheduleRescan()
  })
  reconcileTimer = setInterval(() => {
    scheduleRescan()
  }, 5000)
}

export function stopMcpProjectWatcher(): void {
  watcher?.close()
  watcher = null
  if (rescanTimer) clearTimeout(rescanTimer)
  rescanTimer = null
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = null
}

export function listMcpProjects(): McpProjectSummary[] {
  const projects: McpProjectSummary[] = []
  for (const entry of fs.readdirSync(getProjectsDir(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const project = readJsonFile(path.join(getProjectsDir(), entry.name))
    if (!project) continue
    const summary = summarizeProject(project)
    if (summary) projects.push(summary)
  }
  return projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function getMcpProject(projectId: string): Record<string, unknown> {
  const project = readProject(projectId)
  if (!project) {
    throw new Error(`MCP project not found: ${projectId}`)
  }
  return project
}

export function putMcpProject(
  projectId: string,
  projectPayload: Record<string, unknown>,
  ifMatch?: number,
): PutMcpProjectResult {
  const payloadId = typeof projectPayload.id === 'string' ? projectPayload.id : undefined
  if (payloadId && payloadId !== projectId) {
    throw new Error('Project id mismatch')
  }

  const current = readProject(projectId)
  const currentUpdatedAt = typeof current?.updatedAt === 'number' ? current.updatedAt : undefined

  if (currentUpdatedAt !== undefined && ifMatch !== undefined && currentUpdatedAt > ifMatch) {
    return { status: 'conflict', project: current }
  }

  if (currentUpdatedAt === undefined && ifMatch !== undefined && ifMatch > 0) {
    return { status: 'not_found' }
  }

  const updatedProject: Record<string, unknown> = {
    ...projectPayload,
    id: projectId,
    updatedAt: Date.now(),
  }
  atomicWriteJson(projectPath(projectId), updatedProject)

  const updatedAt = updatedProject.updatedAt
  if (typeof updatedAt === 'number') {
    ignoredWrites.set(projectId, updatedAt)
  }

  return { status: 'ok', project: updatedProject }
}

export function deleteMcpProject(projectId: string): { deleted: boolean } {
  const filePath = projectPath(projectId)
  if (!fs.existsSync(filePath)) {
    return { deleted: false }
  }
  fs.unlinkSync(filePath)
  ignoredDeletes.add(projectId)
  return { deleted: true }
}
