import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getProjectAssetsPath } from '../app-state'
import { getMcpProject, putMcpProject } from '../mcp-project-store'
import { logger } from '../logger'
import { mapProjectPaths } from './project-paths'

// ── Path collection ───────────────────────────────────────────────────────────

/**
 * Collect all unique absolute file paths referenced by the project.
 * Returns { absolutePath, relativePath } pairs — files inside assetsRoot get a
 * relative "assets/..." path; files outside return relativePath: null.
 */
export function collectProjectFilePaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Array<{ absolutePath: string; relativePath: string | null }> {
  const seen = new Set<string>()
  const results: Array<{ absolutePath: string; relativePath: string | null }> = []
  const normalizedRoot = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep

  mapProjectPaths(project, (p: unknown): unknown => {
    if (typeof p !== 'string' || !p) return p
    const lower = p.toLowerCase()
    if (lower.startsWith('http') || lower.startsWith('blob:') || lower.startsWith('data:')) return p
    const resolved = lower.startsWith('file://') ? new URL(p).pathname : p
    if (seen.has(resolved)) return p
    seen.add(resolved)
    if (!fs.existsSync(resolved)) return p

    if (resolved.startsWith(normalizedRoot) || resolved === assetsRoot) {
      const rel = 'assets/' + path.relative(assetsRoot, resolved).split(path.sep).join('/')
      results.push({ absolutePath: resolved, relativePath: rel })
    } else {
      results.push({ absolutePath: resolved, relativePath: null })
    }
    return p
  })

  return results
}

// ── Path rewriting ────────────────────────────────────────────────────────────

/**
 * Deep-clone the project JSON, replacing every absolute path under assetsRoot
 * with a portable "assets/..." relative path.
 */
export function relativizeProjectPaths(
  project: Record<string, unknown>,
  assetsRoot: string,
): Record<string, unknown> {
  const normalizedRoot = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep

  return mapProjectPaths(project, (p: unknown): unknown => {
    if (typeof p !== 'string' || !p) return p
    const lower = p.toLowerCase()
    if (lower.startsWith('http') || lower.startsWith('blob:') || lower.startsWith('data:')) return p
    const resolved = lower.startsWith('file://') ? new URL(p).pathname : p
    if (resolved.startsWith(normalizedRoot)) {
      return 'assets/' + path.relative(assetsRoot, resolved).split(path.sep).join('/')
    }
    return p
  })
}

// ── Pre-bundle normalization ──────────────────────────────────────────────────

/**
 * Copy any project files that live outside assetsRoot into
 * <assetsRoot>/<projectId>/imported/<sha1(absPath).slice(0,12)>/<basename>,
 * then rewrite those fields in the project JSON and persist.
 * Idempotent: files already inside assetsRoot or already copied are skipped.
 */
function normalizeExternalAssets(projectId: string): void {
  const assetsRoot = getProjectAssetsPath()
  const normalizedRoot = assetsRoot.endsWith(path.sep) ? assetsRoot : assetsRoot + path.sep
  const project = getMcpProject(projectId)
  let dirty = false

  const normalized = mapProjectPaths(project, (p: unknown): unknown => {
    if (typeof p !== 'string' || !p) return p
    const lower = p.toLowerCase()
    if (lower.startsWith('http') || lower.startsWith('blob:') || lower.startsWith('data:') || p.startsWith('assets/')) return p
    const resolved = lower.startsWith('file://') ? new URL(p).pathname : p
    if (resolved.startsWith(normalizedRoot)) return p
    if (!fs.existsSync(resolved)) return p

    const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 12)
    const basename = path.basename(resolved)
    const importedDir = path.join(assetsRoot, projectId, 'imported', hash)
    const destPath = path.join(importedDir, basename)

    try {
      const srcStat = fs.statSync(resolved)
      try {
        const destStat = fs.statSync(destPath)
        if (destStat.size === srcStat.size) return destPath
      } catch { /* dest doesn't exist yet */ }
      fs.mkdirSync(importedDir, { recursive: true })
      fs.copyFileSync(resolved, destPath)
      dirty = true
      return destPath
    } catch (err) {
      logger.warn(`[bundler] failed to copy external asset ${resolved}: ${err}`)
      return p
    }
  })

  if (dirty) {
    putMcpProject(projectId, normalized)
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

/** Build the transfer manifest for a project (no disk writes except normalization). */
export function buildTransferManifest(projectId: string): TransferManifest {
  normalizeExternalAssets(projectId)
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
