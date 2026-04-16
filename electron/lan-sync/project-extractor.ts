import fs from 'fs'
import os from 'os'
import path from 'path'
import extractZip from 'extract-zip'
import { getProjectAssetsPath } from '../app-state'
import { approvePath } from '../path-validation'
import { logger } from '../logger'

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
      // Convert forward-slash relative path to OS-native absolute path
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
              return {
                ...c,
                asset: c['asset'] ? transformAsset(c['asset']) : c['asset'],
              }
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

// ── Extraction ────────────────────────────────────────────────────────────────

export interface ExtractionResult {
  projectJson: Record<string, unknown>
  projectId: string
}

/**
 * Extract a .ltxp ZIP archive and return the project JSON with absolute paths
 * restored for this machine. Asset files are copied into getProjectAssetsPath().
 */
export async function extractProjectBundle(archivePath: string, overrides?: { newProjectId?: string; newProjectName?: string }): Promise<ExtractionResult> {
  const tempDir = path.join(os.tmpdir(), `ltx-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    await extractZip(archivePath, { dir: tempDir })

    // Read the portable project JSON
    const manifestPath = path.join(tempDir, 'project.json')
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Invalid .ltxp archive: missing project.json')
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>

    const originalProjectId = typeof raw['id'] === 'string' ? raw['id'] : `project-${Date.now()}`
    const projectId = overrides?.newProjectId ?? originalProjectId

    // Copy assets into the receiver's assets directory
    const assetsRoot = getProjectAssetsPath()
    const srcAssetsDir = path.join(tempDir, 'assets')
    if (fs.existsSync(srcAssetsDir)) {
      const destAssetsDir = assetsRoot
      fs.mkdirSync(destAssetsDir, { recursive: true })
      try {
        fs.cpSync(srcAssetsDir, destAssetsDir, { recursive: true })
      } catch (err) {
        // Clean up partial copy on failure
        const partialDir = path.join(assetsRoot, originalProjectId)
        try { fs.rmSync(partialDir, { recursive: true, force: true }) } catch { /* best-effort */ }
        throw new Error(`Failed to copy assets: ${err}`)
      }
    }

    // Allow renderer to access the new asset files
    const projectAssetsDir = path.join(assetsRoot, originalProjectId)
    if (fs.existsSync(projectAssetsDir)) {
      approvePath(projectAssetsDir)
    }

    // If keeping both (new ID), the assets are still under the original projectId subfolder.
    // This is fine — paths will still resolve correctly since we only change project.id / name.
    let project: Record<string, unknown> = absolutizeProjectPaths(raw, assetsRoot)

    // Apply optional overrides for "keep both" scenario
    if (overrides?.newProjectId) project = { ...project, id: overrides.newProjectId }
    if (overrides?.newProjectName) project = { ...project, name: overrides.newProjectName }

    logger.info(`[LAN Sync] extracted project "${project['name'] ?? projectId}" (${projectId})`)
    return { projectJson: project, projectId }
  } finally {
    // Always clean up temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}
