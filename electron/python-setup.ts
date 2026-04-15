import { execFile, execFileSync } from 'child_process'
import { app } from 'electron'
import fs from 'fs'
import http from 'http'
import https from 'https'
import { load as loadYaml } from 'js-yaml'
import path from 'path'
import { isDev } from './config'
import { logger } from './logger'

export interface PythonSetupProgress {
  status: 'downloading' | 'extracting' | 'complete' | 'error'
  percent: number
  downloadedBytes: number
  totalBytes: number
  speed: number
}

interface ArchiveManifest {
  parts: { name: string; size: number }[]
  totalSize: number
}

interface ReleaseSourceConfig {
  owner: string
  repo: string
  host: string
}

interface RuntimeValidationResult {
  ok: boolean
  details?: string
}

interface ArchiveSourceAttempt {
  url: string
  label: string
  attempts?: number
}

const RUNTIME_VALIDATION_SCRIPT = `
import importlib
import traceback

checks = [
    ("mcp.server.fastmcp", "FastMCP"),
    ("fastapi", None),
    ("uvicorn", None),
]

for module_name, attr_name in checks:
    try:
        module = importlib.import_module(module_name)
        if attr_name is not None:
            getattr(module, attr_name)
    except Exception:
        target = module_name if attr_name is None else f"{module_name}.{attr_name}"
        print(f"FAILED_IMPORT={target}")
        traceback.print_exc()
        raise
`

const RUNTIME_REPAIR_PACKAGES = [
  'fastapi>=0.115.0',
  'uvicorn[standard]>=0.30.0',
  'mcp[cli]>=1.0.0',
  'python-multipart>=0.0.9',
]

// ── GitHub private repo authentication ────────────────────────────────
// Mirrors electron-updater: only sends GH_TOKEN when `private: true` is set
// in the publish config (app-update.yml). This prevents accidental token leaks
// for public repos.

let _authHeaders: Record<string, string> | null = null
let _releaseSourceConfig: ReleaseSourceConfig | null = null

function getUpdateConfigPath(): string {
  return isDev
    ? path.join(process.cwd(), 'dev-app-update.yml')
    : path.join(process.resourcesPath, 'app-update.yml')
}

function readUpdateConfig(): Record<string, unknown> | null {
  try {
    return loadYaml(fs.readFileSync(getUpdateConfigPath(), 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseGitHubHomepage(homepage: string): ReleaseSourceConfig | null {
  try {
    const url = new URL(homepage)
    if (!/github\.com$/i.test(url.hostname)) {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) {
      return null
    }
    return {
      owner: parts[0],
      repo: parts[1],
      host: url.host,
    }
  } catch {
    return null
  }
}

function readPackageHomepageReleaseSource(): ReleaseSourceConfig | null {
  try {
    const packageJsonPath = isDev
      ? path.join(process.cwd(), 'package.json')
      : path.join(app.getAppPath(), 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { homepage?: unknown }
    if (typeof packageJson.homepage !== 'string' || !packageJson.homepage) {
      return null
    }
    return parseGitHubHomepage(packageJson.homepage)
  } catch {
    return null
  }
}

function getReleaseSourceConfig(): ReleaseSourceConfig {
  if (_releaseSourceConfig) {
    return _releaseSourceConfig
  }

  const envOwner = process.env.LTX_RELEASE_OWNER?.trim()
  const envRepo = process.env.LTX_RELEASE_REPO?.trim()
  const envHost = process.env.LTX_RELEASE_HOST?.trim()
  if (envOwner && envRepo) {
    _releaseSourceConfig = {
      owner: envOwner,
      repo: envRepo,
      host: envHost || 'github.com',
    }
    return _releaseSourceConfig
  }

  const updateConfig = readUpdateConfig()
  const provider = typeof updateConfig?.provider === 'string' ? updateConfig.provider.trim() : ''
  const owner = typeof updateConfig?.owner === 'string' ? updateConfig.owner.trim() : ''
  const repo = typeof updateConfig?.repo === 'string' ? updateConfig.repo.trim() : ''
  const host = typeof updateConfig?.host === 'string' ? updateConfig.host.trim() : ''
  if (provider === 'github' && owner && repo) {
    _releaseSourceConfig = {
      owner,
      repo,
      host: host || 'github.com',
    }
    return _releaseSourceConfig
  }

  const homepageSource = readPackageHomepageReleaseSource()
  if (homepageSource) {
    _releaseSourceConfig = homepageSource
    return _releaseSourceConfig
  }

  _releaseSourceConfig = {
    owner: 'Lightricks',
    repo: 'ltx-desktop',
    host: 'github.com',
  }
  return _releaseSourceConfig
}

function getGitHubReleaseBase(version: string): string {
  const { owner, repo, host } = getReleaseSourceConfig()
  return `https://${host}/${owner}/${repo}/releases/download/v${version}`
}

function getAuthHeaders(): Record<string, string> {
  if (_authHeaders !== null) return _authHeaders

  _authHeaders = {}

  let isPrivate = false
  try {
    const config = readUpdateConfig()
    isPrivate = config?.private === true
  } catch { /* no config file — public repo */ }

  if (isPrivate) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (token) {
      _authHeaders = { authorization: `token ${token}` }
    }
  }

  return _authHeaders
}

function getBundledHashPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'python-deps-hash.txt')
  }
  return path.join(process.resourcesPath, 'python-deps-hash.txt')
}

function getInstalledHashPath(): string {
  return path.join(app.getPath('userData'), 'python', 'deps-hash.txt')
}

function getRuntimePythonExecutable(pythonDir = getPythonDir()): string {
  return process.platform === 'win32'
    ? path.join(pythonDir, 'python.exe')
    : path.join(pythonDir, 'bin', 'python3')
}

function getPythonCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONNOUSERSITE: '1',
  }
}

function normalizeExecOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8').trim()
  }
  return ''
}

function truncateDetail(text: string, maxChars = 1600): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  return `${trimmed.slice(0, maxChars)}...`
}

function validateRuntimeModules(pythonPath: string): RuntimeValidationResult {
  if (!fs.existsSync(pythonPath)) {
    return { ok: false, details: `Python executable not found at ${pythonPath}` }
  }

  try {
    execFileSync(
      pythonPath,
      ['-c', RUNTIME_VALIDATION_SCRIPT],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        env: getPythonCommandEnv(),
        maxBuffer: 2 * 1024 * 1024,
      }
    )
    return { ok: true }
  } catch (error) {
    const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
    const stdout = normalizeExecOutput(err.stdout)
    const stderr = normalizeExecOutput(err.stderr)
    const detailParts = [
      stdout ? `stdout: ${truncateDetail(stdout)}` : '',
      stderr ? `stderr: ${truncateDetail(stderr)}` : '',
      err.message ? `error: ${truncateDetail(err.message)}` : '',
    ].filter(Boolean)
    const details = detailParts.join(' | ') || 'Unknown validation failure'
    logger.warn( `[python-setup] Python runtime validation failed for ${pythonPath}: ${details}`)
    return { ok: false, details }
  }
}

function hasRequiredRuntimeModules(pythonPath: string): boolean {
  return validateRuntimeModules(pythonPath).ok
}

function execFileWithCapture(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf-8',
        env: getPythonCommandEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as Error & { stdout?: string; stderr?: string }
          err.stdout = stdout
          err.stderr = stderr
          reject(err)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

async function repairRuntimeModules(pythonPath: string): Promise<{ ok: boolean; details: string }> {
  try {
    const { stdout, stderr } = await execFileWithCapture(
      pythonPath,
      [
        '-m',
        'pip',
        'install',
        '--upgrade',
        '--disable-pip-version-check',
        '--no-warn-script-location',
        ...RUNTIME_REPAIR_PACKAGES,
      ],
      10 * 60 * 1000
    )
    const detailParts = [
      stdout ? `stdout: ${truncateDetail(stdout)}` : '',
      stderr ? `stderr: ${truncateDetail(stderr)}` : '',
    ].filter(Boolean)
    const details = detailParts.join(' | ') || 'pip repair completed successfully'
    logger.info( `[python-setup] Runtime repair completed for ${pythonPath}: ${details}`)
    return { ok: true, details }
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string }
    const stdout = normalizeExecOutput(err.stdout)
    const stderr = normalizeExecOutput(err.stderr)
    const detailParts = [
      stdout ? `stdout: ${truncateDetail(stdout)}` : '',
      stderr ? `stderr: ${truncateDetail(stderr)}` : '',
      err.message ? `error: ${truncateDetail(err.message)}` : '',
    ].filter(Boolean)
    const details = detailParts.join(' | ') || 'pip repair failed'
    logger.warn( `[python-setup] Runtime repair failed for ${pythonPath}: ${details}`)
    return { ok: false, details }
  }
}

function formatRuntimeSetupError(args: {
  archiveHash: string | null
  expectedHash: string | null
  validationDetails: string
  repairDetails?: string
}): string {
  const parts = ['Downloaded Python environment validation failed.']

  if (args.archiveHash && args.expectedHash && args.archiveHash !== args.expectedHash) {
    parts.push(`Downloaded runtime hash ${args.archiveHash} does not match app hash ${args.expectedHash}.`)
  } else if (!args.archiveHash && args.expectedHash) {
    parts.push(`Downloaded runtime archive did not include deps-hash.txt (expected ${args.expectedHash}).`)
  }

  parts.push(`Validation details: ${args.validationDetails}`)

  if (args.repairDetails) {
    parts.push(`Repair attempt: ${args.repairDetails}`)
  }

  return parts.join(' ')
}

/** Directory where python-embed lives at runtime. */
export function getPythonDir(): string {
  if (isDev) {
    return path.join(process.cwd(), 'python-embed')
  }

  // Packaged builds ship with a fully bundled runtime for offline installs.
  return path.join(process.resourcesPath, 'python')
}

/**
 * Check whether the Python environment is ready to use.
 */
export function isPythonReady(): { ready: boolean } {
  if (isDev) {
    return { ready: true }
  }

  const pythonExe = getRuntimePythonExecutable()

  return { ready: hasRequiredRuntimeModules(pythonExe) }
}

/**
 * Pre-download python-embed for an upcoming app update (Windows only).
 * Downloads to userData/python-next/ so the next launch can promote it instantly.
 * Returns true if a download was performed, false if not needed.
 */
export async function preDownloadPythonForUpdate(
  newVersion: string,
  onProgress?: (progress: PythonSetupProgress) => void
): Promise<boolean> {
  void newVersion
  void onProgress
  return false
}

export async function downloadPythonEmbed(
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  if (!isDev) {
    const pythonExe = getRuntimePythonExecutable()
    const validationResult = validateRuntimeModules(pythonExe)

    if (!validationResult.ok) {
      throw new Error(
        `Bundled Python environment is not ready. ${validationResult.details || 'Missing required runtime modules.'}`
      )
    }

    onProgress({ status: 'extracting', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    onProgress({ status: 'complete', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    logger.info('[python-setup] Using bundled Python runtime from app resources')
    return
  }

  await downloadPythonEmbedRuntime(onProgress)
}

function readHash(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return null
  }
}

// ── Archive source resolution ─────────────────────────────────────────
// Primary: GitHub Releases (multi-part, version-based)
// Fallback: public CDN bucket (single file, deps-hash-based)

const DEFAULT_UPSTREAM_CDN_BASE = 'https://storage.googleapis.com/ltx-desktop-artifacts'

function getPythonArchivePrefix(): string {
  if (process.platform === 'win32') return 'python-embed-win32'
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'python-embed-linux-x64'
    if (process.arch === 'arm64') return 'python-embed-linux-arm64'
    throw new Error(`Unsupported Linux architecture: ${process.arch}`)
  }
  throw new Error(`Python download is not supported on ${process.platform}`)
}

function getArchiveBase(): string {
  // LTX_PYTHON_URL is a dev-only override for testing with local archives.
  // Disabled in production to prevent code injection into a signed app.
  if (isDev && process.env.LTX_PYTHON_URL) {
    return process.env.LTX_PYTHON_URL.replace(/^["']+|["']+$/g, '')
  }
  const version = app.getVersion()
  return getGitHubReleaseBase(version)
}

function getArchiveCdnBase(): string | null {
  const explicit = process.env.LTX_RELEASE_CDN_BASE?.trim()
  if (explicit) {
    return explicit.replace(/\/+$/, '')
  }

  const { owner, repo } = getReleaseSourceConfig()
  if (owner === 'Lightricks' && repo.toLowerCase() === 'ltx-desktop') {
    return DEFAULT_UPSTREAM_CDN_BASE
  }

  return null
}

function getFallbackArchiveUrl(): string | null {
  const cdnBase = getArchiveCdnBase()
  if (!cdnBase) return null
  const hash = readHash(getBundledHashPath())
  if (!hash) return null
  const prefix = getPythonArchivePrefix()
  return `${cdnBase}/${prefix}/${hash}/${prefix}.tar.gz`
}

function getGitHubSingleFileArchiveUrl(base: string): string | null {
  if (!base.includes('/releases/download/')) {
    return null
  }
  return `${base}/${getPythonArchivePrefix()}.tar.gz`
}

function isLocalPath(source: string): boolean {
  return !source.startsWith('http://') && !source.startsWith('https://')
}

/**
 * Acquire the python-embed archive from a source (local, GitHub, or CDN).
 * Returns once the archive is written to archivePath.
 */
async function acquireArchive(
  base: string,
  archivePath: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  if (base.endsWith('.tar.gz')) {
    if (isLocalPath(base)) {
      await copyFileWithProgress(base, archivePath, 0, fs.statSync(base).size, onProgress)
    } else {
      let lastTime = Date.now()
      let lastBytes = 0
      let speed = 0

      await downloadFileWithGlobalProgress(base, archivePath, 0, 0, (downloaded, totalBytes) => {
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000
        if (elapsed >= 1) {
          speed = (downloaded - lastBytes) / elapsed
          lastTime = now
          lastBytes = downloaded
        }

        onProgress({
          status: 'downloading',
          percent: totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0,
          downloadedBytes: downloaded,
          totalBytes,
          speed,
        })
      })
    }
  } else if (isLocalPath(base)) {
    await acquirePartsLocal(base, archivePath, cleanupFiles, onProgress)
  } else if (base.includes('/releases/download/')) {
    // GitHub Releases — multi-part
    await acquirePartsRemote(base, archivePath, cleanupFiles, onProgress)
  } else {
    // CDN or other URL — single file (content-length discovered from response)
    let lastTime = Date.now()
    let lastBytes = 0
    let speed = 0

    await downloadFileWithGlobalProgress(base, archivePath, 0, 0, (downloaded, totalBytes) => {
      const now = Date.now()
      const elapsed = (now - lastTime) / 1000
      if (elapsed >= 1) {
        speed = (downloaded - lastBytes) / elapsed
        lastTime = now
        lastBytes = downloaded
      }

      onProgress({
        status: 'downloading',
        percent: totalBytes > 0 ? Math.round((downloaded / totalBytes) * 100) : 0,
        downloadedBytes: downloaded,
        totalBytes,
        speed,
      })
    })
  }
}

function cleanupArchiveArtifacts(archivePath: string, cleanupFiles: string[]): void {
  try { fs.unlinkSync(archivePath) } catch { /* ignore */ }
  for (const file of cleanupFiles) {
    try { fs.unlinkSync(file) } catch { /* ignore */ }
  }
  cleanupFiles.length = 0
}

function resetDirectory(dirPath: string): void {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
    }
  } catch { /* ignore */ }
  fs.mkdirSync(dirPath, { recursive: true })
}

function verifyFileSize(filePath: string, expectedSize: number, label: string): void {
  let stats: fs.Stats
  try {
    stats = fs.statSync(filePath)
  } catch (error) {
    throw new Error(`${label} missing after download: ${error}`)
  }

  if (stats.size !== expectedSize) {
    throw new Error(`${label} size mismatch: expected ${expectedSize} bytes, got ${stats.size}`)
  }
}

async function downloadAndExtractArchiveFromSources(
  sources: ArchiveSourceAttempt[],
  archivePath: string,
  tempDir: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const errors: string[] = []

  for (const source of sources) {
    const attempts = Math.max(1, source.attempts ?? 1)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        cleanupArchiveArtifacts(archivePath, cleanupFiles)
        resetDirectory(tempDir)

        logger.info( `[python-setup] Downloading archive from ${source.label} (attempt ${attempt}/${attempts}): ${source.url}`)
        await acquireArchive(source.url, archivePath, cleanupFiles, onProgress)

        onProgress({ status: 'extracting', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
        logger.info( `[python-setup] Extracting archive from ${source.label} (attempt ${attempt}/${attempts}) to: ${tempDir}`)
        await extractTarGz(archivePath, tempDir)
        return
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        errors.push(`${source.label} attempt ${attempt}/${attempts}: ${detail}`)
        logger.warn( `[python-setup] Archive attempt failed for ${source.label} (${attempt}/${attempts}): ${detail}`)
      }
    }
  }

  throw new Error(`All Python archive sources failed. ${errors.join(' | ')}`)
}

/**
 * Download (or copy) python-embed archive and extract to userData/python/.
 * Tries GitHub Releases first, falls back to CDN if available.
 */
async function downloadPythonEmbedRuntime(
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const destDir = path.join(app.getPath('userData'), 'python')
  const tempDir = path.join(app.getPath('userData'), 'python-tmp')
  const archivePath = path.join(app.getPath('userData'), `${getPythonArchivePrefix()}.tar.gz`)

  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  } catch { /* ignore */ }

  fs.mkdirSync(tempDir, { recursive: true })

  const cleanupFiles: string[] = []

  try {
    const base = getArchiveBase()
    logger.info( `[python-setup] Archive base: ${base}`)
    const fallbackUrl = getFallbackArchiveUrl()
    const sources: ArchiveSourceAttempt[] = [{ url: base, label: 'primary', attempts: 2 }]
    const singleFileUrl = getGitHubSingleFileArchiveUrl(base)
    if (singleFileUrl && singleFileUrl !== base) {
      sources.push({ url: singleFileUrl, label: 'github-single-file' })
    }
    if (fallbackUrl && !isLocalPath(base) && fallbackUrl !== base) {
      sources.push({ url: fallbackUrl, label: 'cdn-fallback' })
    }

    await downloadAndExtractArchiveFromSources(sources, archivePath, tempDir, cleanupFiles, onProgress)

    // Move into place (archive has top-level `python-embed/` directory)
    const extractedInner = path.join(tempDir, 'python-embed')
    const extractedSource = fs.existsSync(extractedInner) ? extractedInner : tempDir

    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    fs.renameSync(extractedSource, destDir)

    const pythonExe = getRuntimePythonExecutable(destDir)
    const expectedHash = readHash(getBundledHashPath())
    const archiveHash = readHash(path.join(destDir, 'deps-hash.txt'))

    if (archiveHash && expectedHash && archiveHash !== expectedHash) {
      logger.warn(
        `[python-setup] Downloaded runtime hash mismatch: archive=${archiveHash} expected=${expectedHash}`
      )
    } else if (!archiveHash && expectedHash) {
      logger.warn(
        `[python-setup] Downloaded runtime archive is missing deps-hash.txt (expected ${expectedHash})`
      )
    }

    let validationResult = validateRuntimeModules(pythonExe)
    let repairDetails: string | undefined
    if (!validationResult.ok) {
      logger.info( '[python-setup] Attempting to repair downloaded runtime modules via pip')
      const repairResult = await repairRuntimeModules(pythonExe)
      repairDetails = repairResult.details
      validationResult = validateRuntimeModules(pythonExe)
    }

    if (!validationResult.ok) {
      throw new Error(formatRuntimeSetupError({
        archiveHash,
        expectedHash,
        validationDetails: validationResult.details || 'Missing required runtime modules.',
        repairDetails,
      }))
    }

    // Write deps hash so subsequent launches skip download
    const bundledHash = getBundledHashPath()
    if (fs.existsSync(bundledHash)) {
      fs.copyFileSync(bundledHash, path.join(destDir, 'deps-hash.txt'))
    }

    onProgress({ status: 'complete', percent: 100, downloadedBytes: 0, totalBytes: 0, speed: 0 })
    logger.info( '[python-setup] Python environment ready')
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  } finally {
    cleanupArchiveArtifacts(archivePath, cleanupFiles)
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ── Multi-part: local directory ──────────────────────────────────────

async function acquirePartsLocal(
  dirPath: string,
  archivePath: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  const manifestPath = path.join(dirPath, `${getPythonArchivePrefix()}.manifest.json`)
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))

  const partPaths: string[] = []
  let bytesSoFar = 0

  for (const part of manifest.parts) {
    const src = path.join(dirPath, part.name)
    const dest = path.join(app.getPath('userData'), part.name)
    partPaths.push(dest)
    cleanupFiles.push(dest)

    await copyFileWithProgress(src, dest, bytesSoFar, manifest.totalSize, onProgress)
    verifyFileSize(dest, part.size, `local part ${part.name}`)
    bytesSoFar += part.size
  }

  await concatenateParts(partPaths, archivePath)
  verifyFileSize(archivePath, manifest.totalSize, 'assembled local archive')
}

// ── Multi-part: remote download ──────────────────────────────────────

async function acquirePartsRemote(
  baseUrl: string,
  archivePath: string,
  cleanupFiles: string[],
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  // Fetch manifest
  const prefix = getPythonArchivePrefix()
  const manifestUrl = `${baseUrl}/${prefix}.manifest.json`
  const manifestDest = path.join(app.getPath('userData'), `${prefix}.manifest.json`)
  cleanupFiles.push(manifestDest)
  await downloadFileRaw(manifestUrl, manifestDest)
  const manifest: ArchiveManifest = JSON.parse(fs.readFileSync(manifestDest, 'utf-8'))

  const partPaths: string[] = []
  let bytesSoFar = 0
  let lastTime = Date.now()
  let lastReportedBytes = 0
  let speed = 0

  for (const part of manifest.parts) {
    const partUrl = `${baseUrl}/${part.name}`
    const partDest = path.join(app.getPath('userData'), part.name)
    partPaths.push(partDest)
    cleanupFiles.push(partDest)

    await downloadFileWithGlobalProgress(
      partUrl,
      partDest,
      bytesSoFar,
      manifest.totalSize,
      (globalDownloaded, totalBytes) => {
        const now = Date.now()
        const elapsed = (now - lastTime) / 1000

        if (elapsed >= 1) {
          speed = (globalDownloaded - lastReportedBytes) / elapsed
          lastTime = now
          lastReportedBytes = globalDownloaded
        }

        onProgress({
          status: 'downloading',
          percent: Math.round((globalDownloaded / totalBytes) * 100),
          downloadedBytes: globalDownloaded,
          totalBytes,
          speed,
        })
      }
    )

    verifyFileSize(partDest, part.size, `downloaded part ${part.name}`)
    bytesSoFar += part.size
  }

  await concatenateParts(partPaths, archivePath)
  verifyFileSize(archivePath, manifest.totalSize, 'assembled release archive')
}

// ── File operations ──────────────────────────────────────────────────

function concatenateParts(parts: string[], dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(dest)
    let i = 0

    function writeNext() {
      if (i >= parts.length) {
        writeStream.end(() => resolve())
        return
      }

      const readStream = fs.createReadStream(parts[i])
      i++

      readStream.on('error', (err) => {
        writeStream.destroy()
        reject(err)
      })

      readStream.on('end', writeNext)
      readStream.pipe(writeStream, { end: false })
    }

    writeStream.on('error', reject)
    writeNext()
  })
}

/** Copy a local file with progress relative to a global total. */
function copyFileWithProgress(
  source: string,
  dest: string,
  globalOffset: number,
  globalTotal: number,
  onProgress: (progress: PythonSetupProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let copiedBytes = 0

    const readStream = fs.createReadStream(source)
    const writeStream = fs.createWriteStream(dest)

    readStream.on('data', (chunk: Buffer) => {
      copiedBytes += chunk.length
      const totalDone = globalOffset + copiedBytes
      onProgress({
        status: 'downloading',
        percent: Math.round((totalDone / globalTotal) * 100),
        downloadedBytes: totalDone,
        totalBytes: globalTotal,
        speed: 0,
      })
    })

    readStream.on('error', reject)
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)

    readStream.pipe(writeStream)
  })
}

/** Download a file without progress (used for manifest). */
function downloadFileRaw(url: string, dest: string, redirectCount = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'))
      return
    }

    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { headers: getAuthHeaders() }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFileRaw(res.headers.location, dest, redirectCount + 1).then(resolve).catch(reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      const file = fs.createWriteStream(dest)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    })

    req.on('error', reject)
  })
}

/** Download a file, reporting progress as (globalDownloaded, globalTotal). */
function downloadFileWithGlobalProgress(
  url: string,
  dest: string,
  globalOffset: number,
  globalTotal: number,
  onProgress: (globalDownloaded: number, globalTotal: number) => void,
  redirectCount = 0
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'))
      return
    }

    const client = url.startsWith('https') ? https : http
    const req = client.get(url, { headers: getAuthHeaders() }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFileWithGlobalProgress(res.headers.location, dest, globalOffset, globalTotal, onProgress, redirectCount + 1)
          .then(resolve).catch(reject)
        return
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${res.statusCode}`))
        return
      }

      // If caller didn't know total, use content-length from response
      const effectiveTotal = globalTotal || parseInt(res.headers['content-length'] || '0', 10)

      let downloadedBytes = 0
      const file = fs.createWriteStream(dest)
      res.pipe(file)

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        onProgress(globalOffset + downloadedBytes, effectiveTotal)
      })

      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err) })
    })

    req.on('error', reject)
  })
}

/** Extract a .tar.gz file using the system tar command (ships on Windows 10+). */
function extractTarGz(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', destDir], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`tar extraction failed: ${stderr || err.message}`))
        return
      }
      resolve()
    })
  })
}


