import { electronAPISchemas, type BackendHealthStatus, type LanSyncPeer, type LanSyncProgressEvent, type LanSyncIncomingRequest, type LanPairedDevice, type LanPairingRequest } from '../shared/electron-api-schema'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const api: Record<string, unknown> = {}

for (const key of Object.keys(electronAPISchemas)) {
  api[key] = (input?: unknown) => ipcRenderer.invoke(key, input)
}

api.onPythonSetupProgress = (cb: (data: unknown) => void) => {
  ipcRenderer.on('python-setup-progress', (_: unknown, data: unknown) => cb(data))
}

api.removePythonSetupProgress = () => {
  ipcRenderer.removeAllListeners('python-setup-progress')
}

api.onBackendHealthStatus = (cb: (data: BackendHealthStatus) => void) => {
  const listener = (_: unknown, data: BackendHealthStatus) => cb(data)
  ipcRenderer.on('backend-health-status', listener)
  return () => {
    ipcRenderer.removeListener('backend-health-status', listener)
  }
}

api.onMcpProjectChanged = (cb: (data: unknown) => void) => {
  const listener = (_: unknown, data: unknown) => cb(data)
  ipcRenderer.on('mcp-project-changed', listener)
  return () => {
    ipcRenderer.removeListener('mcp-project-changed', listener)
  }
}

api.onExportProgress = (cb: (percent: number) => void) => {
  ipcRenderer.on('export-progress', (_: unknown, percent: number) => cb(percent))
}

api.removeExportProgress = () => {
  ipcRenderer.removeAllListeners('export-progress')
}

api.onLanSyncPeersChanged = (cb: (peers: LanSyncPeer[]) => void) => {
  const listener = (_: unknown, data: LanSyncPeer[]) => cb(data)
  ipcRenderer.on('lan-sync-peers-changed', listener)
  return () => { ipcRenderer.removeListener('lan-sync-peers-changed', listener) }
}

api.onLanSyncProgress = (cb: (event: LanSyncProgressEvent) => void) => {
  const listener = (_: unknown, data: LanSyncProgressEvent) => cb(data)
  ipcRenderer.on('lan-sync-progress', listener)
  return () => { ipcRenderer.removeListener('lan-sync-progress', listener) }
}

api.onLanSyncIncomingRequest = (cb: (event: LanSyncIncomingRequest) => void) => {
  const listener = (_: unknown, data: LanSyncIncomingRequest) => cb(data)
  ipcRenderer.on('lan-sync-incoming-request', listener)
  return () => { ipcRenderer.removeListener('lan-sync-incoming-request', listener) }
}

api.onLanSyncPairingRequest = (cb: (event: LanPairingRequest) => void) => {
  const listener = (_: unknown, data: LanPairingRequest) => cb(data)
  ipcRenderer.on('lan-sync-pairing-request', listener)
  return () => { ipcRenderer.removeListener('lan-sync-pairing-request', listener) }
}

api.onLanSyncPairedDevicesChanged = (cb: (devices: LanPairedDevice[]) => void) => {
  const listener = (_: unknown, data: LanPairedDevice[]) => cb(data)
  ipcRenderer.on('lan-sync-paired-devices-changed', listener)
  return () => { ipcRenderer.removeListener('lan-sync-paired-devices-changed', listener) }
}

api.getPathForFile = (file: File) => webUtils.getPathForFile(file)

api.platform = process.platform

contextBridge.exposeInMainWorld('electronAPI', api)

export {}
