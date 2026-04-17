import fs from 'fs'
import path from 'path'
import { getProjectAssetsPath } from '../app-state'
import { getMcpProject } from '../mcp-project-store'

// ── Path collection ───────────────────────────────────────────────────────────

/**
 * Collect all unique absolute file paths referenced by the project.
 * Returns { absolutePath, relativePath } pairs for files under assetsRoot.
 * Files outside assetsRoot are returned with a null relativePath (cannot be transferred).
 */
export function collectProjectFilePaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Array<{ absolutePath: string; relativePath: string | null }> {
  const seen = new Set<string>()
  const results: Array<{ absolutePath: string; relativePath: string | null }> = []

  function addPath(p: unknown): void {
    if (typeof p !== 'string' || !p) return
    const lower = p.toLowerCase()
    if (lower.startsWith('http') || lower.startsWith('blob:') || lower.startsWith('data:')) return
    const resolved = lower.startsWith('file://') ? new URL(p).pathname : p
    if (seen.has(resolved)) return
    seen.add(resolved)

    if (!fs.existsSync(resolved)) return

    const normalizedRoot = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep
    if (resolved.startsWith(normalizedRoot) || resolved === assetsRoot) {
      const rel = 'assets/' + path.relative(assetsRoot, resolved).split(path.sep).join('/')
      results.push({ absolutePath: resolved, relativePath: rel })
    } else {
      results.push({ absolutePath: resolved, relativePath: null })
    }
  }

  function walkAsset(asset: unknown): void {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return
    const a = asset as Record<string, unknown>
    addPath(a['path'])
    addPath(a['bigThumbnailPath'])
    addPath(a['smallThumbnailPath'])
    addPath(a['thumbnail'])
    if (Array.isArray(a['takes'])) {
      for (const take of a['takes']) {
        const t = take as Record<string, unknown>
        addPath(t['path'])
        addPath(t['bigThumbnailPath'])
        addPath(t['smallThumbnailPath'])
        addPath(t['thumbnail'])
      }
    }
  }

  if (Array.isArray(project['assets'])) {
    for (const asset of project['assets']) walkAsset(asset)
  }

  if (Array.isArray(project['timelines'])) {
    for (const timeline of project['timelines']) {
      if (!timeline || typeof timeline !== 'object') continue
      const tl = timeline as Record<string, unknown>
      if (Array.isArray(tl['clips'])) {
        for (const clip of tl['clips']) {
          if (!clip || typeof clip !== 'object') continue
          const c = clip as Record<string, unknown>
          if (c['asset']) walkAsset(c['asset'])
        }
      }
    }
  }

  return results
}

// ── Path rewriting ────────────────────────────────────────────────────────────

/**
 * Deep-clone the project JSON, replacing every absolute path that starts with
 * assetsRoot with a relative "assets/..." path.
 */
export function relativizeProjectPaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Record<string, unknown> {
  const normalizedRoot = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep

  function rel(p: unknown): unknown {
    if (typeof p !== 'string' || !p) return p
    const lower = p.toLowerCase()
    if (lower.startsWith('http') || lower.startsWith('blob:') || lower.startsWith('data:')) return p
    const resolved = lower.startsWith('file://') ? new URL(p).pathname : p
    if (resolved.startsWith(normalizedRoot)) {
      return 'assets/' + path.relative(assetsRoot, resolved).split(path.sep).join('/')
    }
    return p
  }

  function transformAsset(asset: unknown): unknown {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
    const a = asset as Record<string, unknown>
    return {
      ...a,
      path: rel(a['path']),
      bigThumbnailPath: rel(a['bigThumbnailPath']),
      smallThumbnailPath: rel(a['smallThumbnailPath']),
      thumbnail: rel(a['thumbnail']),
      takes: Array.isArray(a['takes'])
        ? a['takes'].map((take) => {
            const t = take as Record<string, unknown>
            return {
              ...t,
              path: rel(t['path']),
              bigThumbnailPath: rel(t['bigThumbnailPath']),
              smallThumbnailPath: rel(t['smallThumbnailPath']),
              thumbnail: rel(t['thumbnail']),
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

// ── Transfer manifest ─────────────────────────────────────────────────────────

export interface TransferFile {
  rel: string       // relative path inside the bundle, e.g. "assets/proj-id/clip.mp4"
  absolutePath: string
  size: number
}

export interface TransferManifest {
  project: Record<string, unknown>  // relativized project JSON
  files: TransferFile[]
  totalBytes: number
}

/** Build the transfer manifest for a project (no disk writes). */
export function buildTransferManifest(projectId: string): TransferManifest {
  const project = getMcpProject(projectId)
  const assetsRoot = getProjectAssetsPath()
  const filePaths = collectProjectFilePaths(project, assetsRoot)
  const portable = relativizeProjectPaths(project, assetsRoot)

  const files: TransferFile[] = []
  let totalBytes = 0
  for (const { absolutePath, relativePath } of filePaths) {
    if (!relativePath) continue
    try {
      const size = fs.statSync(absolutePath).size
      files.push({ rel: relativePath, absolutePath, size })
      totalBytes += size
    } catch { /* skip missing files */ }
  }

  return { project: portable, files, totalBytes }
}
