/**
 * IPC client for the cellary daemon.
 *
 * Connects to the daemon's Unix socket, sends JSON-RPC requests,
 * and receives event notifications.
 *
 * This module is the only part of the daemon package that CLI/GUI imports.
 */

import { EventEmitter } from 'node:events'
import { connect, type Socket } from 'node:net'

import superjson from 'superjson'

import type {
  DaemonStatus,
  IpcDeviceInfo,
  IpcDiscoveryInfo,
  IpcEventNotification,
  JsonRpcNotification,
  JsonRpcRequest,
} from './protocol.js'
import {
  daemonStatusSchema,
  getSocketPath,
  ipcDeviceInfoSchema,
  ipcEventNotificationSchema,
  jsonRpcNotificationSchema,
  jsonRpcResponseSchema,
} from './protocol.js'
import { RemoteInteractiveStream } from './remote-stream.js'
import { streamCloseSchema, streamDataSchema, streamOpenResultSchema } from './stream-protocol.js'

// Re-export types that CLI/GUI consumers need
export type { DaemonStatus, IpcDeviceInfo, IpcDiscoveryInfo, IpcEventNotification }

// ── Types ──────────────────────────────────────────────────────────────────

export interface DaemonClientOptions {
  readonly socketPath?: string | undefined
  /** Connection timeout in ms. Default: 3000. */
  readonly connectTimeoutMs?: number | undefined
  /** Request timeout in ms. Default: 30000. */
  readonly requestTimeoutMs?: number | undefined
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface DaemonClientEvents {
  event: [notification: IpcEventNotification]
  disconnect: []
}

// ── Client ─────────────────────────────────────────────────────────────────

export declare interface DaemonClient {
  on<K extends keyof DaemonClientEvents>(
    event: K,
    listener: (...args: DaemonClientEvents[K]) => void,
  ): this
  off<K extends keyof DaemonClientEvents>(
    event: K,
    listener: (...args: DaemonClientEvents[K]) => void,
  ): this
  emit<K extends keyof DaemonClientEvents>(event: K, ...args: DaemonClientEvents[K]): boolean
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Maximum buffer size before discarding (1 MB). */
const MAX_BUFFER_SIZE = 1_048_576

export class DaemonClient extends EventEmitter {
  private readonly _socketPath: string
  private readonly _connectTimeoutMs: number
  private readonly _requestTimeoutMs: number

  private _socket: Socket | null = null
  private _nextId = 1
  private _pending = new Map<number, PendingRequest>()
  private _streams = new Map<string, RemoteInteractiveStream>()

  constructor(options?: DaemonClientOptions) {
    super()
    this._socketPath = options?.socketPath ?? getSocketPath()
    this._connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this._requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get connected(): boolean {
    return this._socket !== null && !this._socket.destroyed
  }

  /** Connect to the daemon. Throws if daemon is not running. */
  async connect(): Promise<void> {
    if (this._socket) return

    const socket = await new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(`Daemon connection timed out (${this._socketPath})`))
      }, this._connectTimeoutMs)

      const sock = connect(this._socketPath, () => {
        clearTimeout(timer)
        resolve(sock)
      })

      sock.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(new Error(`Cannot connect to daemon at ${this._socketPath}: ${err.message}`))
      })
    })

    this._socket = socket
    let buffer = ''

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')

      // Guard against unbounded buffer growth from malformed daemon output
      if (buffer.length > MAX_BUFFER_SIZE) {
        buffer = ''
        return
      }

      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length > 0) this._handleMessage(line)
        newlineIdx = buffer.indexOf('\n')
      }
    })

    socket.on('close', () => {
      this._socket = null
      // Reject all pending requests
      for (const pending of this._pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Daemon connection closed'))
      }
      this._pending.clear()
      // Close all active streams
      for (const stream of this._streams.values()) {
        stream._receiveClose()
      }
      this._streams.clear()
      this.emit('disconnect')
    })

    socket.on('error', () => {
      // close event will fire after this
    })
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
  }

  // ── Typed convenience methods ────────────────────────────────────────────

  async listDevices(): Promise<IpcDeviceInfo[]> {
    const raw = await this.call('devices.list')
    const arr = Array.isArray(raw) ? raw : []
    return arr.map((item: unknown) => ipcDeviceInfoSchema.parse(item))
  }

  async waitForReady(timeoutMs?: number): Promise<string> {
    const raw = await this.call('devices.waitForReady', { timeoutMs })
    if (typeof raw !== 'string') throw new Error('Expected string deviceId from waitForReady')
    return raw
  }

  async status(): Promise<DaemonStatus> {
    const raw = await this.call('daemon.status')
    return daemonStatusSchema.parse(raw)
  }

  async shutdown(): Promise<void> {
    await this.call('daemon.shutdown')
  }

  async subscribe(deviceId: string, events: string[]): Promise<void> {
    await this.call('subscribe', { deviceId, events })
  }

  async unsubscribe(deviceId: string): Promise<void> {
    await this.call('unsubscribe', { deviceId })
  }

  async provision(deviceId: string): Promise<unknown> {
    return this.call('devices.provision', { deviceId })
  }

  /**
   * Hardware-reset a device's USB transport.
   *
   * Performs a USB bus reset to recover from a stuck modem (all AT commands
   * timing out). The device will re-enumerate and be re-discovered automatically.
   */
  async resetDevice(deviceId: string): Promise<void> {
    await this.call('device.reset', { deviceId })
  }

  /**
   * Call a device service method.
   *
   * Wraps the generic call() with deviceId injection.
   * Response is unvalidated (unknown) — callers must validate.
   */
  async serviceCall(
    method: string,
    deviceId: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.call(method, { deviceId, ...params }, timeoutMs)
  }

  // ── Stream support ─────────────────────────────────────────────────────────

  /**
   * Open a multiplexed byte stream to a device.
   *
   * Sends a stream.open RPC request, then returns an InteractiveStream
   * that proxies data as base64-encoded JSON-RPC notifications.
   */
  async openStream(deviceId: string, type: string): Promise<RemoteInteractiveStream> {
    const raw = await this.call('stream.open', { deviceId, type })
    const { streamId } = streamOpenResultSchema.parse(raw)

    const stream = new RemoteInteractiveStream(streamId, (method, params) =>
      this.sendNotification(method, params),
    )
    this._streams.set(streamId, stream)

    return stream
  }

  /** Send a JSON-RPC notification to the daemon (no response expected). */
  sendNotification(method: string, params?: unknown): void {
    if (!this._socket || this._socket.destroyed) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this._socket.write(`${JSON.stringify(notification)}\n`)
  }

  // ── Generic RPC call ─────────────────────────────────────────────────────

  /** Send a JSON-RPC request and wait for the response. */
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this._socket || this._socket.destroyed) {
      return Promise.reject(new Error('Not connected to daemon'))
    }

    const id = this._nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const effectiveTimeout = timeoutMs ?? this._requestTimeoutMs

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`Request ${method} timed out after ${effectiveTimeout}ms`))
      }, effectiveTimeout)

      this._pending.set(id, { resolve, reject, timer })

      // Node.js socket.write() buffers internally — if the socket is dead,
      // the 'close' handler fires and rejects all pending requests.
      this._socket?.write(`${JSON.stringify(request)}\n`)
    })
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = superjson.parse(raw)
    } catch {
      return
    }

    // Try as JSON-RPC response (has 'id' field)
    const responseResult = jsonRpcResponseSchema.safeParse(parsed)
    if (responseResult.success && responseResult.data.id !== null) {
      const response = responseResult.data
      const numericId =
        typeof response.id === 'number' ? response.id : Number.parseInt(String(response.id), 10)
      const pending = this._pending.get(numericId)
      if (!pending) return

      this._pending.delete(numericId)
      clearTimeout(pending.timer)

      if (response.error !== undefined) {
        pending.reject(new DaemonRpcError(response.error.code, response.error.message))
      } else {
        pending.resolve(response.result)
      }
      return
    }

    // Try as JSON-RPC notification (has 'method' field, no 'id')
    const notifResult = jsonRpcNotificationSchema.safeParse(parsed)
    if (!notifResult.success) return

    const { method: notifMethod, params: notifParams } = notifResult.data

    if (notifMethod === 'event') {
      const eventResult = ipcEventNotificationSchema.safeParse(notifParams)
      if (eventResult.success) {
        this.emit('event', eventResult.data)
      }
      return
    }

    if (notifMethod === 'stream.data') {
      const dataResult = streamDataSchema.safeParse(notifParams)
      if (dataResult.success) {
        this._streams.get(dataResult.data.streamId)?._receiveData(dataResult.data.data)
      }
      return
    }

    if (notifMethod === 'stream.close') {
      const closeResult = streamCloseSchema.safeParse(notifParams)
      if (closeResult.success) {
        const stream = this._streams.get(closeResult.data.streamId)
        if (stream) {
          this._streams.delete(closeResult.data.streamId)
          stream._receiveClose()
        }
      }
    }
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class DaemonRpcError extends Error {
  override readonly name = 'DaemonRpcError'

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Check if the daemon is running by attempting a fast connection.
 * Returns true if the socket is reachable, false otherwise.
 */
export async function isDaemonRunning(socketPath?: string): Promise<boolean> {
  const path = socketPath ?? getSocketPath()

  return new Promise((resolve) => {
    const sock = connect(path, () => {
      sock.destroy()
      resolve(true)
    })

    sock.on('error', () => {
      resolve(false)
    })

    // Fast timeout -- just checking if the socket exists
    setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, 500)
  })
}
