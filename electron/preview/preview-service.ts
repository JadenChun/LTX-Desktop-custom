import { app, BrowserWindow, type Rectangle } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import os from 'os'
import path from 'path'
import { previewClipRequestSchema, previewFrameRequestSchema, type PreviewClipRequest, type PreviewClipResponse, type PreviewFrameRequest, type PreviewFrameResponse } from '../../shared/agent-preview-schema'
import { isDev, getCurrentDir } from '../config'
import { findFfmpegPath, runFfmpeg } from '../export/ffmpeg-utils'
import { logger } from '../logger'

let previewWindow: BrowserWindow | null = null
let previewServer: http.Server | null = null
let previewServerUrl: string | null = null
let previewServerToken: string | null = null
let previewRenderQueue: Promise<void> = Promise.resolve()

async function runPreviewRenderExclusive<T>(task: () => Promise<T>): Promise<T> {
  const nextTask = previewRenderQueue.then(task, task)
  previewRenderQueue = nextTask.then(
    () => undefined,
    () => undefined,
  )
  return nextTask
}

function getPreviewPreloadPath(): string {
  return isDev
    ? path.join(getCurrentDir(), 'dist-electron', 'preload.js')
    : path.join(app.getAppPath(), 'dist-electron', 'preload.js')
}

async function loadPreviewWindow(window: BrowserWindow): Promise<void> {
  if (isDev) {
    await window.loadURL('http://localhost:5173/?agentPreview=1')
    return
  }
  await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), {
    query: { agentPreview: '1' },
  })
}

async function waitForPreviewBridge(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const tick = () => {
        if (window.__LTX_AGENT_PREVIEW_BRIDGE?.renderFrame) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('Agent preview bridge did not initialize in time.'));
          return;
        }
        window.setTimeout(tick, 25);
      };
      tick();
    })`,
    true,
  )
}

async function ensurePreviewWindow(): Promise<BrowserWindow> {
  if (previewWindow && !previewWindow.isDestroyed()) {
    return previewWindow
  }

  previewWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: false,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: getPreviewPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: isDev ? false : true,
      backgroundThrottling: false,
    },
  })

  previewWindow.on('closed', () => {
    previewWindow = null
  })

  await loadPreviewWindow(previewWindow)
  await waitForPreviewBridge(previewWindow)
  return previewWindow
}

function normalizeFrameSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(64, Math.round(width)),
    height: Math.max(64, Math.round(height)),
  }
}

function ensureOutputPath(fileExtension: string, explicitPath?: string): string {
  if (explicitPath) {
    fs.mkdirSync(path.dirname(explicitPath), { recursive: true })
    return explicitPath
  }

  const outputDir = path.join(os.tmpdir(), 'ltx-agent-previews')
  fs.mkdirSync(outputDir, { recursive: true })
  return path.join(outputDir, `preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExtension}`)
}

async function resizePreviewWindow(window: BrowserWindow, width: number, height: number): Promise<void> {
  window.setContentSize(width, height)
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => resolve(), 32)
    window.once('resize', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function renderPreviewFrameToImage(request: PreviewFrameRequest): Promise<PreviewFrameResponse> {
  const window = await ensurePreviewWindow()
  const { width, height } = normalizeFrameSize(request.width, request.height)
  await resizePreviewWindow(window, width, height)

  const serializedRequest = JSON.stringify({
    project: request.project,
    time: request.time,
    width,
    height,
  })
  await window.webContents.executeJavaScript(
    `window.__LTX_AGENT_PREVIEW_BRIDGE.renderFrame(${serializedRequest})`,
    true,
  )
  const captured = await window.capturePage({ x: 0, y: 0, width, height } satisfies Rectangle)
  const outputPath = ensureOutputPath('png', request.outputPath)
  const resized = captured.getSize().width === width && captured.getSize().height === height
    ? captured
    : captured.resize({ width, height })
  fs.writeFileSync(outputPath, resized.toPNG())

  return {
    imagePath: outputPath,
    time: request.time,
    width,
    height,
  }
}

async function encodePreviewFrames({
  framePattern,
  fps,
  outputPath,
}: {
  framePattern: string
  fps: number
  outputPath: string
}): Promise<void> {
  const ffmpegPath = findFfmpegPath()
  if (!ffmpegPath) {
    throw new Error('FFmpeg not found for preview clip rendering.')
  }

  const result = await runFfmpeg(ffmpegPath, [
    '-y',
    '-framerate', String(fps),
    '-i', framePattern,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ])

  if (!result.success) {
    throw new Error(result.error || 'FFmpeg failed to encode preview clip.')
  }
}

async function renderPreviewClipToVideo(request: PreviewClipRequest): Promise<PreviewClipResponse> {
  const outputPath = ensureOutputPath('mp4', request.outputPath)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-agent-preview-clip-'))
  const frameCount = Math.max(1, Math.ceil(request.duration * request.fps))

  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const frameTime = request.startTime + (frameIndex / request.fps)
      const framePath = path.join(tmpDir, `frame_${String(frameIndex).padStart(4, '0')}.png`)
      await renderPreviewFrameToImage({
        project: request.project,
        time: frameTime,
        width: request.width,
        height: request.height,
        outputPath: framePath,
      })
    }

    await encodePreviewFrames({
      framePattern: path.join(tmpDir, 'frame_%04d.png'),
      fps: request.fps,
      outputPath,
    })

    return {
      videoPath: outputPath,
      startTime: request.startTime,
      duration: request.duration,
      fps: request.fps,
      frameCount,
      width: Math.max(64, Math.round(request.width)),
      height: Math.max(64, Math.round(request.height)),
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, statusCode: number, payload: object): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function authorizeRequest(req: IncomingMessage): boolean {
  if (!previewServerToken) return false
  const authHeader = req.headers.authorization ?? ''
  return authHeader === `Bearer ${previewServerToken}`
}

async function handlePreviewRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorizeRequest(req)) {
    sendJson(res, 401, { error: 'Unauthorized preview bridge request.' })
    return
  }
  if (req.method !== 'POST' || !req.url) {
    sendJson(res, 404, { error: 'Not found.' })
    return
  }

  try {
    const payload = JSON.parse(await readRequestBody(req)) as unknown
    if (req.url === '/preview/frame') {
      const parsed = previewFrameRequestSchema.parse(payload)
      const response = await runPreviewRenderExclusive(() => renderPreviewFrameToImage(parsed))
      sendJson(res, 200, response)
      return
    }
    if (req.url === '/preview/clip') {
      const parsed = previewClipRequestSchema.parse(payload)
      const response = await runPreviewRenderExclusive(() => renderPreviewClipToVideo(parsed))
      sendJson(res, 200, response)
      return
    }
    sendJson(res, 404, { error: 'Unknown preview endpoint.' })
  } catch (error) {
    logger.error(`Preview bridge request failed: ${error}`)
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

export async function ensurePreviewBridgeServer(): Promise<{ url: string; token: string }> {
  if (previewServer && previewServerUrl && previewServerToken) {
    return { url: previewServerUrl, token: previewServerToken }
  }

  previewServerToken = crypto.randomBytes(24).toString('base64url')
  previewServer = http.createServer((req, res) => {
    void handlePreviewRequest(req, res)
  })

  await new Promise<void>((resolve, reject) => {
    previewServer!.once('error', reject)
    previewServer!.listen(0, '127.0.0.1', () => resolve())
  })

  const address = previewServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Preview bridge failed to bind to a localhost port.')
  }

  previewServerUrl = `http://127.0.0.1:${address.port}`
  logger.info(`Preview bridge listening on ${previewServerUrl}`)
  return { url: previewServerUrl, token: previewServerToken }
}

export async function stopPreviewBridgeServer(): Promise<void> {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.destroy()
    previewWindow = null
  }

  if (!previewServer) {
    previewServerUrl = null
    previewServerToken = null
    return
  }

  await new Promise<void>((resolve) => {
    previewServer?.close(() => resolve())
  })
  previewServer = null
  previewServerUrl = null
  previewServerToken = null
}
