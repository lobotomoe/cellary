/**
 * Backend factory for CLI commands.
 *
 * Decides which backend to use: remote (daemon IPC) when the daemon
 * is running, direct (USB/serial) otherwise.
 */

import { isDaemonRunning } from '@cellary/daemon/client'

import type { Backend, ConnectOptions, DeviceHandle } from './types.js'

export type { Backend, ConnectOptions, DeviceHandle }

import { DirectBackend } from './direct.js'
import { RemoteBackend } from './remote.js'

/**
 * Create the appropriate backend.
 *
 * Checks if the daemon is running. If so, returns RemoteBackend (no sudo needed).
 * Otherwise, falls back to DirectBackend (direct USB/serial access).
 */
export async function createBackend(): Promise<Backend> {
  const daemonAvailable = await isDaemonRunning()
  if (daemonAvailable) {
    return new RemoteBackend()
  }
  return new DirectBackend()
}

/**
 * Convenience helper for fleet operations (list, provision, watch).
 *
 * Creates a backend, runs the callback, disposes.
 * Use this when you don't need to connect to a specific device.
 */
export async function withBackend<T>(fn: (backend: Backend) => Promise<T>): Promise<T> {
  const backend = await createBackend()
  try {
    return await fn(backend)
  } finally {
    await backend.dispose()
  }
}

/**
 * Convenience helper: connect, run a callback, close.
 *
 * Handles backend creation, connection, and cleanup so commands
 * don't repeat the try/finally boilerplate.
 */
export async function withDevice<T>(
  options: ConnectOptions | undefined,
  fn: (handle: DeviceHandle) => Promise<T>,
): Promise<T> {
  const backend = await createBackend()
  const handle = await backend.connect(options)
  try {
    return await fn(handle)
  } finally {
    await handle.close()
    await backend.dispose()
  }
}
