import crypto from 'crypto'
import { readAppState, writeAppState, type PairedDevice } from '../app-state'

export type { PairedDevice }

/** Generate a fresh pair token (base64url, 32 bytes of entropy). */
export function generatePairToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function listPaired(): PairedDevice[] {
  const state = readAppState()
  return state.pairedDevices ?? []
}

export function findPairedByDeviceId(deviceId: string): PairedDevice | undefined {
  return listPaired().find(d => d.deviceId === deviceId)
}

export function findPairedByPairToken(token: string): PairedDevice | undefined {
  return listPaired().find(d => d.pairToken === token)
}

/** Add or update a paired device. Deduped by deviceId. */
export function upsertPaired(device: PairedDevice): void {
  const state = readAppState()
  const list = state.pairedDevices ?? []
  const idx = list.findIndex(d => d.deviceId === device.deviceId)
  if (idx >= 0) list[idx] = device
  else list.push(device)
  state.pairedDevices = list
  writeAppState(state)
}

/** Remove a paired device by deviceId. Returns true if something was removed. */
export function removePaired(deviceId: string): boolean {
  const state = readAppState()
  const list = state.pairedDevices ?? []
  const next = list.filter(d => d.deviceId !== deviceId)
  if (next.length === list.length) return false
  state.pairedDevices = next
  writeAppState(state)
  return true
}
