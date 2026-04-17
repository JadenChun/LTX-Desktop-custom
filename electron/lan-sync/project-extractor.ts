import fs from 'fs'
import path from 'path'
import { getProjectAssetsPath } from '../app-state'
import { approvePath } from '../path-validation'
import { mapProjectPaths } from './project-paths'

// ── Path restoration ──────────────────────────────────────────────────────────

/**
 * Rewrite relative "assets/..." paths back to absolute paths using the
 * receiver's assetsRoot as the base.
 */
export function absolutizeProjectPaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Record<string, unknown> {
  return mapProjectPaths(project, (p: unknown): unknown => {
    if (typeof p !== 'string' || !p) return p
    if (p.startsWith('assets/')) {
      const segments = p.slice('assets/'.length).split('/')
      return path.join(assetsRoot, ...segments)
    }
    return p
  })
}

// ── Install ───────────────────────────────────────────────────────────────────

export interface InstallResult {
  projectJson: Record<string, unknown>
  projectId: string
}

/**
 * Given the relativized project JSON (already received from the sender),
 * absolutize paths and apply optional overrides. Asset files are expected to
 * have already been written to assetsRoot by the transfer-manager.
 */
export function installProjectJson(
  portableProject: Record<string, unknown>,
  overrides?: { newProjectId?: string; newProjectName?: string },
): InstallResult {
  const assetsRoot = getProjectAssetsPath()
  let project = absolutizeProjectPaths(portableProject, assetsRoot)

  const originalProjectId = typeof portableProject['id'] === 'string' ? portableProject['id'] : `project-${Date.now()}`
  const projectId = overrides?.newProjectId ?? originalProjectId

  if (overrides?.newProjectId) project = { ...project, id: overrides.newProjectId }
  if (overrides?.newProjectName) project = { ...project, name: overrides.newProjectName }

  // Allow renderer to access the project's asset directory
  const projectAssetsDir = path.join(assetsRoot, originalProjectId)
  fs.mkdirSync(projectAssetsDir, { recursive: true })
  approvePath(projectAssetsDir)

  return { projectJson: project, projectId }
}
