import fs from 'fs'
import path from 'path'
import { getProjectAssetsPath } from '../app-state'
import { approvePath } from '../path-validation'

// ── Path restoration ──────────────────────────────────────────────────────────

/**
 * Rewrite relative "assets/..." paths back to absolute paths using the
 * receiver's assetsRoot as the base.
 */
export function absolutizeProjectPaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Record<string, unknown> {
  function abs(p: unknown): unknown {
    if (typeof p !== 'string' || !p) return p
    if (p.startsWith('assets/')) {
      const segments = p.slice('assets/'.length).split('/')
      return path.join(assetsRoot, ...segments)
    }
    return p
  }

  function transformAsset(asset: unknown): unknown {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
    const a = asset as Record<string, unknown>
    return {
      ...a,
      path: abs(a['path']),
      bigThumbnailPath: abs(a['bigThumbnailPath']),
      smallThumbnailPath: abs(a['smallThumbnailPath']),
      thumbnail: abs(a['thumbnail']),
      takes: Array.isArray(a['takes'])
        ? a['takes'].map((take) => {
            const t = take as Record<string, unknown>
            return {
              ...t,
              path: abs(t['path']),
              bigThumbnailPath: abs(t['bigThumbnailPath']),
              smallThumbnailPath: abs(t['smallThumbnailPath']),
              thumbnail: abs(t['thumbnail']),
            }
          })
        : a['takes'],
    }
  }

  function transformTimelines(timelines: unknown): unknown {
    if (!Array.isArray(timelines)) return timelines
    return timelines.map((timeline) => {
      if (!timeline || typeof timeline !== 'object') return timeline
      const tl = timeline as Record<string, unknown>
      return {
        ...tl,
        clips: Array.isArray(tl['clips'])
          ? tl['clips'].map((clip) => {
              if (!clip || typeof clip !== 'object') return clip
              const c = clip as Record<string, unknown>
              return { ...c, asset: c['asset'] ? transformAsset(c['asset']) : c['asset'] }
            })
          : tl['clips'],
      }
    })
  }

  return {
    ...project,
    assets: Array.isArray(project['assets']) ? project['assets'].map(transformAsset) : project['assets'],
    timelines: transformTimelines(project['timelines']),
  }
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
