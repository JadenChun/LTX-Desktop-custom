import { z } from 'zod'

const fileFilter = z.object({ name: z.string(), extensions: z.array(z.string()) })

function ipcResult<T extends z.ZodRawShape>(valueShape: T) {
  return z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), ...valueShape }),
    z.object({ success: z.literal(false), error: z.string() }),
  ])
}

export type IpcResult<T extends z.ZodRawShape> = z.infer<ReturnType<typeof ipcResult<T>>>

const emptyResult = ipcResult({})

const kenBurnsKeyframe = z.object({
  scale: z.number(),
  focusX: z.number(),
  focusY: z.number(),
})

const kenBurnsMotion = z.object({
  type: z.literal('ken_burns'),
  start: kenBurnsKeyframe,
  end: kenBurnsKeyframe,
  easing: z.enum(['linear', 'easeInOut']).optional(),
})

const colorCorrection = z.object({
  brightness: z.number(),
  contrast: z.number(),
  saturation: z.number(),
  temperature: z.number().optional(),
  tint: z.number().optional(),
  exposure: z.number().optional(),
  highlights: z.number().optional(),
  shadows: z.number().optional(),
})

const exportClip = z.object({
  path: z.string(),
  type: z.string(),
  startTime: z.number(),
  duration: z.number(),
  trimStart: z.number(),
  speed: z.number(),
  reversed: z.boolean(),
  flipH: z.boolean(),
  flipV: z.boolean(),
  opacity: z.number(),
  trackIndex: z.number(),
  muted: z.boolean(),
  volume: z.number(),
  transitionIn: z.object({ type: z.string(), duration: z.number() }).optional(),
  transitionOut: z.object({ type: z.string(), duration: z.number() }).optional(),
  audioFadeInDuration: z.number().optional(),
  audioFadeOutDuration: z.number().optional(),
  motion: kenBurnsMotion.optional(),
  colorCorrection: colorCorrection.optional(),
})

const exportSubtitle = z.object({
  text: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  style: z.object({
    fontSize: z.number(),
    fontFamily: z.string(),
    fontWeight: z.string(),
    color: z.string(),
    backgroundColor: z.string(),
    position: z.string(),
    italic: z.boolean(),
    highlightEnabled: z.boolean().optional(),
    highlightColor: z.string().optional(),
  }),
})

const exportTextOverlay = z.object({
  text: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  trackIndex: z.number(),
  style: z.object({
    fontFamily: z.string(),
    fontSize: z.number(),
    fontWeight: z.string(),
    fontStyle: z.string(),
    color: z.string(),
    backgroundColor: z.string(),
    textAlign: z.string(),
    positionX: z.number(),
    positionY: z.number(),
    strokeColor: z.string(),
    strokeWidth: z.number(),
    shadowColor: z.string(),
    shadowBlur: z.number(),
    shadowOffsetX: z.number(),
    shadowOffsetY: z.number(),
    letterSpacing: z.number(),
    lineHeight: z.number(),
    maxWidth: z.number(),
    padding: z.number(),
    borderRadius: z.number(),
    opacity: z.number(),
  }),
})

const logsResponse = z.object({
  logPath: z.string(),
  lines: z.array(z.string()),
  error: z.string().optional(),
})

const backendHealthStatus = z.object({
  status: z.enum(['alive', 'restarting', 'dead']),
  exitCode: z.number().nullable().optional(),
})

export type BackendHealthStatus = z.infer<typeof backendHealthStatus>
const mcpProjectSummary = z.object({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  assetCount: z.number(),
  clipCount: z.number(),
})
const mcpProjectPayload = z.record(z.string(), z.unknown())
const putMcpProjectResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), project: mcpProjectPayload }),
  z.object({ status: z.literal('conflict'), project: mcpProjectPayload }),
  z.object({ status: z.literal('not_found') }),
])
const mcpProjectChangeEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('updated'), projectId: z.string(), updatedAt: z.number() }),
  z.object({ kind: z.literal('deleted'), projectId: z.string() }),
])

export type McpProjectChangeEvent = z.infer<typeof mcpProjectChangeEvent>

export const electronAPISchemas = {
  // App info
  getBackend: {
    input: z.object({}),
    output: z.object({ url: z.string(), token: z.string() }),
  },
  getModelsPath: {
    input: z.object({}),
    output: z.string(),
  },
  readLocalFile: {
    input: z.object({ filePath: z.string() }),
    output: z.object({ data: z.string(), mimeType: z.string() }),
  },
  checkGpu: {
    input: z.object({}),
    output: z.object({ available: z.boolean(), name: z.string().optional(), vram: z.number().optional() }),
  },
  getAppInfo: {
    input: z.object({}),
    output: z.object({ version: z.string(), isPackaged: z.boolean(), modelsPath: z.string(), userDataPath: z.string() }),
  },

  // First-run setup
  checkFirstRun: {
    input: z.object({}),
    output: z.object({ needsSetup: z.boolean(), needsLicense: z.boolean() }),
  },
  acceptLicense: {
    input: z.object({}),
    output: z.boolean(),
  },
  completeSetup: {
    input: z.object({}),
    output: z.boolean(),
  },
  fetchLicenseText: {
    input: z.object({}),
    output: z.string(),
  },
  getNoticesText: {
    input: z.object({}),
    output: z.string(),
  },

  // Open external pages / folders
  openLtxApiKeyPage: {
    input: z.object({}),
    output: z.boolean(),
  },
  openFalApiKeyPage: {
    input: z.object({}),
    output: z.boolean(),
  },
  openParentFolderOfFile: {
    input: z.object({ filePath: z.string() }),
    output: z.void(),
  },
  showItemInFolder: {
    input: z.object({ filePath: z.string() }),
    output: z.void(),
  },
  approvePaths: {
    input: z.object({ filePaths: z.array(z.string()) }),
    output: z.void(),
  },

  // Logs
  getLogs: {
    input: z.object({}),
    output: logsResponse,
  },
  getLogPath: {
    input: z.object({}),
    output: z.object({ logPath: z.string(), logDir: z.string() }),
  },
  openLogFolder: {
    input: z.object({}),
    output: z.boolean(),
  },

  // Paths
  getResourcePath: {
    input: z.object({}),
    output: z.string().nullable(),
  },
  getDownloadsPath: {
    input: z.object({}),
    output: z.string(),
  },

  // Project assets
  addVisualAssetToProject: {
    input: z.object({ srcPath: z.string(), projectId: z.string(), type: z.enum(['video', 'image']) }),
    output: ipcResult({
      path: z.string(),
      bigThumbnailPath: z.string(),
      smallThumbnailPath: z.string(),
      width: z.number(),
      height: z.number(),
    }),
  },
  addGenericAssetToProject: {
    input: z.object({ srcPath: z.string(), projectId: z.string() }),
    output: ipcResult({ path: z.string() }),
  },
  makeThumbnailsForProjectAsset: {
    input: z.object({ path: z.string(), type: z.enum(['video', 'image']) }),
    output: ipcResult({
      bigThumbnailPath: z.string(),
      smallThumbnailPath: z.string(),
    }),
  },
  makeDimensionsForProjectAsset: {
    input: z.object({ path: z.string(), type: z.enum(['video', 'image']) }),
    output: ipcResult({
      width: z.number(),
      height: z.number(),
    }),
  },
  getProjectAssetsPath: {
    input: z.object({}),
    output: z.string(),
  },
  listMcpProjects: {
    input: z.object({}),
    output: z.array(mcpProjectSummary),
  },
  getMcpProject: {
    input: z.object({ projectId: z.string() }),
    output: mcpProjectPayload,
  },
  putMcpProject: {
    input: z.object({
      projectId: z.string(),
      project: mcpProjectPayload,
      ifMatch: z.number().optional(),
    }),
    output: putMcpProjectResult,
  },
  deleteMcpProject: {
    input: z.object({ projectId: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
  openProjectAssetsPathChangeDialog: {
    input: z.object({}),
    output: ipcResult({ path: z.string() }),
  },

  // File dialogs & save
  showSaveDialog: {
    input: z.object({
      title: z.string().optional(),
      defaultPath: z.string().optional(),
      filters: z.array(fileFilter).optional(),
    }),
    output: z.string().nullable(),
  },
  saveFile: {
    input: z.object({ filePath: z.string(), data: z.string(), encoding: z.string().optional() }),
    output: ipcResult({ path: z.string() }),
  },
  saveBinaryFile: {
    input: z.object({ filePath: z.string(), data: z.instanceof(ArrayBuffer) }),
    output: ipcResult({ path: z.string() }),
  },
  showOpenDirectoryDialog: {
    input: z.object({ title: z.string().optional() }),
    output: z.string().nullable(),
  },
  searchDirectoryForFiles: {
    input: z.object({ directory: z.string(), filenames: z.array(z.string()) }),
    output: z.record(z.string(), z.string()),
  },
  checkFilesExist: {
    input: z.object({ filePaths: z.array(z.string()) }),
    output: z.record(z.string(), z.boolean()),
  },
  showOpenFileDialog: {
    input: z.object({
      title: z.string().optional(),
      filters: z.array(fileFilter).optional(),
      properties: z.array(z.string()).optional(),
    }),
    output: z.array(z.string()).nullable(),
  },

  // Video export
  exportNative: {
    input: z.object({
      clips: z.array(exportClip),
      outputPath: z.string(),
      codec: z.string(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      quality: z.number(),
      letterbox: z.object({ ratio: z.number(), color: z.string(), opacity: z.number() }).optional(),
      subtitles: z.array(exportSubtitle).optional(),
      textOverlays: z.array(exportTextOverlay).optional(),
    }),
    output: emptyResult,
  },
  exportCancel: {
    input: z.object({ sessionId: z.string() }),
    output: emptyResult,
  },

  // Python setup
  checkPythonReady: {
    input: z.object({}),
    output: z.object({ ready: z.boolean() }),
  },
  startPythonSetup: {
    input: z.object({}),
    output: z.void(),
  },
  startPythonBackend: {
    input: z.object({}),
    output: z.void(),
  },
  restartPythonBackend: {
    input: z.object({}),
    output: z.void(),
  },
  getBackendHealthStatus: {
    input: z.object({}),
    output: backendHealthStatus.nullable(),
  },

  // Video processing
  extractVideoFrame: {
    input: z.object({ videoPath: z.string(), seekTime: z.number(), width: z.number().optional(), quality: z.number().optional() }),
    output: z.object({ path: z.string() }),
  },

  // Logging
  writeLog: {
    input: z.object({ level: z.string(), message: z.string() }),
    output: z.void(),
  },

  // Models
  openModelsDirChangeDialog: {
    input: z.object({}),
    output: ipcResult({ path: z.string() }),
  },

  // Analytics
  getAnalyticsState: {
    input: z.object({}),
    output: z.object({ analyticsEnabled: z.boolean(), installationId: z.string() }),
  },
  setAnalyticsEnabled: {
    input: z.object({ enabled: z.boolean() }),
    output: z.void(),
  },
  sendAnalyticsEvent: {
    input: z.object({ eventName: z.string(), extraDetails: z.record(z.string(), z.unknown()).nullable().optional() }),
    output: z.void(),
  },

  // LAN Sync
  lanSyncGetStatus: {
    input: z.object({}),
    output: z.object({ enabled: z.boolean(), deviceName: z.string(), port: z.number().nullable() }),
  },
  lanSyncSetEnabled: {
    input: z.object({ enabled: z.boolean() }),
    output: z.void(),
  },
  lanSyncListRemoteProjects: {
    input: z.object({ peerId: z.string() }),
    output: z.array(mcpProjectSummary),
  },
  lanSyncStartTransfer: {
    input: z.object({ peerId: z.string(), projectId: z.string(), newProjectId: z.string().optional(), newProjectName: z.string().optional() }),
    output: ipcResult({ transferId: z.string() }),
  },
  lanSyncCancelTransfer: {
    input: z.object({ transferId: z.string() }),
    output: z.void(),
  },
  lanSyncApproveIncoming: {
    input: z.object({ transferId: z.string(), approved: z.boolean() }),
    output: z.void(),
  },
  lanSyncRefresh: {
    input: z.object({}),
    output: z.void(),
  },
} as const

type Schemas = typeof electronAPISchemas

type InvokeAPI = {
  [K in keyof Schemas]: z.infer<Schemas[K]['input']> extends Record<string, never>
    ? () => Promise<z.infer<Schemas[K]['output']>>
    : (input: z.infer<Schemas[K]['input']>) => Promise<z.infer<Schemas[K]['output']>>
}

export interface LanSyncPeer {
  id: string
  deviceName: string
  address: string
  port: number
  lastSeen: number
  token: string
}

export interface LanSyncProgressEvent {
  transferId: string
  phase: 'downloading' | 'extracting' | 'complete' | 'error'
  bytesReceived: number
  totalBytes: number
  errorMessage?: string
}

export interface LanSyncIncomingRequest {
  transferId: string
  fromDeviceName: string
  projectId: string
  projectName: string
  estimatedBytes: number
}

export type ElectronAPI = InvokeAPI & {
  onPythonSetupProgress: (cb: (data: unknown) => void) => void
  removePythonSetupProgress: () => void
  onBackendHealthStatus: (cb: (data: BackendHealthStatus) => void) => (() => void)
  onMcpProjectChanged: (cb: (event: McpProjectChangeEvent) => void) => (() => void)
  onExportProgress: (cb: (percent: number) => void) => void
  removeExportProgress: () => void
  onLanSyncPeersChanged: (cb: (peers: LanSyncPeer[]) => void) => (() => void)
  onLanSyncProgress: (cb: (event: LanSyncProgressEvent) => void) => (() => void)
  onLanSyncIncomingRequest: (cb: (event: LanSyncIncomingRequest) => void) => (() => void)
  getPathForFile: (file: File) => string
  platform: string
}
