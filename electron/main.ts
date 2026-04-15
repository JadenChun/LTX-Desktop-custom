import './app-paths'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { setupCSP } from './csp'
import { registerExportHandlers } from './export/export-handler'
import { stopExportProcess } from './export/ffmpeg-utils'
import { registerAppHandlers } from './ipc/app-handlers'
import { registerFileHandlers } from './ipc/file-handlers'
import { registerLogHandlers } from './ipc/log-handlers'
import { registerMcpProjectHandlers } from './ipc/mcp-project-handlers'
import { registerVideoProcessingHandlers } from './ipc/video-processing-handlers'
import { initSessionLog } from './logging-management'
import { startMcpProjectWatcher, stopMcpProjectWatcher } from './mcp-project-store'
import { ensurePreviewBridgeServer, stopPreviewBridgeServer } from './preview/preview-service'
import { runPythonMcpStdio, stopPythonBackend } from './python-backend'
import { initAutoUpdater } from './updater'
import { createWindow, getMainWindow } from './window'
import { sendAnalyticsEvent } from './analytics'

function logAppVersion(): void {
  if (!app.isPackaged) {
    console.log('[LTX Desktop] Running in development mode')
  } else {
    console.log(`[LTX Desktop] Version ${app.getVersion()}`)
  }
}

function isMcpStdioCliInvocation(argv: string[]): boolean {
  const mcpIndex = argv.indexOf('mcp')
  return mcpIndex !== -1 && argv[mcpIndex + 1] === 'stdio'
}

if (isMcpStdioCliInvocation(process.argv)) {
  void app.whenReady()
    .then(async () => {
      const exitCode = await runPythonMcpStdio()
      app.exit(exitCode)
    })
    .catch(() => {
      app.exit(1)
    })
} else {
  const gotLock = app.requestSingleInstanceLock()

  if (!gotLock) {
    app.quit()
  } else {
    initSessionLog()
    logAppVersion()

    registerAppHandlers()
    registerFileHandlers()
    registerLogHandlers()
    registerMcpProjectHandlers()
    registerExportHandlers()
    registerVideoProcessingHandlers()

    app.on('second-instance', () => {
      const mainWindow = getMainWindow()
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        if (!mainWindow.isVisible()) {
          mainWindow.show()
        }
        mainWindow.focus()
        return
      }
      if (app.isReady()) {
        createWindow()
      }
    })

    app.whenReady().then(async () => {
      setupCSP()
      await ensurePreviewBridgeServer()
      startMcpProjectWatcher()
      // Ensure outputs directory exists for imported media files
      const outputsDir = path.join(process.cwd(), 'outputs')
      if (!fs.existsSync(outputsDir)) {
        fs.mkdirSync(outputsDir, { recursive: true })
        console.log('[LTX Desktop] Created outputs directory:', outputsDir)
      }
      createWindow()
      initAutoUpdater()
      // Python setup + backend start are now driven by the renderer via IPC

      // Fire analytics event (no-op if user hasn't opted in)
      void sendAnalyticsEvent('ltxdesktop_app_launched')
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        stopPythonBackend()
        app.quit()
      }
    })

    app.on('activate', () => {
      if (getMainWindow() === null) {
        createWindow()
      }
    })

    app.on('before-quit', () => {
      stopMcpProjectWatcher()
      stopExportProcess()
      stopPythonBackend()
      void stopPreviewBridgeServer()
    })
  }
}
