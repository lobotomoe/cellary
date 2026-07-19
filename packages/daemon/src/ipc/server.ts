/**
 * JSON-RPC 2.0 server over Unix domain socket / Windows named pipe.
 *
 * Each client gets a dedicated connection with its own event subscriptions.
 * Messages are newline-delimited JSON.
 */

import { chmodSync, chownSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'

import superjson from 'superjson'
import { z } from 'zod'

import type { JsonRpcNotification, JsonRpcResponse } from './protocol.js'
import { getSocketPath, RPC_ERRORS } from './protocol.js'

const incomingRequestSchema = z.object({
  method: z.string(),
  id: z.union([z.number(), z.string()]),
  params: z.unknown().optional(),
})

const incomingNotificationSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
})

/** Maximum buffer size per client (1 MB). Prevents runaway memory from malformed input. */
const MAX_BUFFER_SIZE = 1_048_576

/**
 * Default socket permissions: owner + group read/write, no world access.
 * The daemon runs as root, so without a group gid this restricts access to
 * root only. A group gid (see {@link IpcServerOptions.socketGid}) widens it to
 * an authorized operator group — the socket mode is the actual authorization
 * boundary for this privileged daemon, so it must never be world-accessible.
 */
const DEFAULT_SOCKET_MODE = 0o660

// ── Types ──────────────────────────────────────────────────────────────────

export type RequestHandler = (method: string, params: unknown, clientId: string) => Promise<unknown>

export type NotificationHandler = (method: string, params: unknown, clientId: string) => void

export interface IpcServerOptions {
  readonly socketPath?: string | undefined
  /**
   * Numeric group id to chown the socket to, allowing non-root clients in that
   * group to connect. When undefined, the socket stays owner-only (root).
   */
  readonly socketGid?: number | undefined
  /** Socket file mode. Defaults to {@link DEFAULT_SOCKET_MODE} (0o660). */
  readonly socketMode?: number | undefined
  /** Called with a human-readable warning when the socket ACL may be too permissive/restrictive. */
  readonly onWarning?: ((message: string) => void) | undefined
  readonly onRequest: RequestHandler
  readonly onNotification?: NotificationHandler | undefined
  readonly onClientConnected?: (clientId: string) => void
  readonly onClientDisconnected?: (clientId: string) => void
}

export interface ClientConnection {
  readonly id: string
  readonly socket: Socket
}

// ── Server ─────────────────────────────────────────────────────────────────

export class IpcServer {
  private readonly _socketPath: string
  private readonly _socketGid: number | undefined
  private readonly _socketMode: number
  private readonly _onWarning: ((message: string) => void) | undefined
  private readonly _onRequest: RequestHandler
  private readonly _onNotification: NotificationHandler | undefined
  private readonly _onClientConnected: ((clientId: string) => void) | undefined
  private readonly _onClientDisconnected: ((clientId: string) => void) | undefined

  private _server: Server | null = null
  private _clients = new Map<string, ClientConnection>()
  private _nextClientId = 1

  constructor(options: IpcServerOptions) {
    this._socketPath = options.socketPath ?? getSocketPath()
    this._socketGid = options.socketGid
    this._socketMode = options.socketMode ?? DEFAULT_SOCKET_MODE
    this._onWarning = options.onWarning
    this._onRequest = options.onRequest
    this._onNotification = options.onNotification
    this._onClientConnected = options.onClientConnected
    this._onClientDisconnected = options.onClientDisconnected
  }

  get clientCount(): number {
    return this._clients.size
  }

  async start(): Promise<void> {
    // Clean up stale socket file from previous crash
    if (existsSync(this._socketPath)) {
      unlinkSync(this._socketPath)
    }

    const server = createServer((socket) => this._handleConnection(socket))

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject)
      server.listen(this._socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    // Restrict socket access. The daemon runs as root; the socket mode is the
    // authorization boundary, so it must never be world-accessible. A group gid
    // (resolved by the installer) lets authorized non-root operators connect.
    if (process.platform !== 'win32') {
      chmodSync(this._socketPath, this._socketMode)
      if (this._socketGid !== undefined) {
        const uid = process.getuid?.() ?? 0
        chownSync(this._socketPath, uid, this._socketGid)
      } else {
        this._onWarning?.(
          `IPC socket ${this._socketPath} is restricted to the daemon owner (uid ` +
            `${process.getuid?.() ?? 0}); non-root clients cannot connect. ` +
            `Set CELLARY_SOCKET_GID to grant a group access.`,
        )
      }
    }

    this._server = server
  }

  async stop(): Promise<void> {
    const server = this._server
    if (!server) return

    // Close all client connections
    for (const client of this._clients.values()) {
      client.socket.destroy()
    }
    this._clients.clear()

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    this._server = null

    // Clean up socket file
    try {
      if (existsSync(this._socketPath)) {
        unlinkSync(this._socketPath)
      }
    } catch {
      // May have been cleaned up by another process
    }
  }

  /** Send a notification to a specific client. */
  notify(clientId: string, notification: JsonRpcNotification): void {
    const client = this._clients.get(clientId)
    if (!client) return
    writeLine(client.socket, notification)
  }

  /** Send a notification to all connected clients. */
  broadcast(notification: JsonRpcNotification): void {
    for (const client of this._clients.values()) {
      writeLine(client.socket, notification)
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _handleConnection(socket: Socket): void {
    const clientId = `client-${this._nextClientId++}`
    const client: ClientConnection = { id: clientId, socket }
    this._clients.set(clientId, client)

    this._onClientConnected?.(clientId)

    let buffer = ''

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')

      // Guard against unbounded buffer growth (no newline = no message boundary).
      // Once a frame exceeds the cap the stream is unframeable, so tear the
      // connection down rather than truncating and desyncing all later frames.
      if (buffer.length > MAX_BUFFER_SIZE) {
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC_ERRORS.PARSE_ERROR, message: 'Message too large' },
        }
        writeLine(client.socket, response)
        client.socket.destroy()
        return
      }

      // Process complete lines (newline-delimited JSON)
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)

        if (line.length > 0) {
          this._handleMessage(client, line).catch(() => {
            // Handler errors are caught and sent as JSON-RPC errors
          })
        }

        newlineIdx = buffer.indexOf('\n')
      }
    })

    socket.on('close', () => {
      this._clients.delete(clientId)
      this._onClientDisconnected?.(clientId)
    })

    socket.on('error', () => {
      this._clients.delete(clientId)
      this._onClientDisconnected?.(clientId)
    })
  }

  private async _handleMessage(client: ClientConnection, raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_ERRORS.PARSE_ERROR, message: 'Parse error' },
      }
      writeLine(client.socket, response)
      return
    }

    // Discriminate: request (has id) vs notification (no id) per JSON-RPC 2.0
    const idResult = z.object({ id: z.union([z.number(), z.string()]) }).safeParse(parsed)

    if (idResult.success) {
      await this._handleRequest(client, parsed, idResult.data.id)
    } else {
      this._handleClientNotification(client, parsed)
    }
  }

  private async _handleRequest(
    client: ClientConnection,
    parsed: unknown,
    id: number | string,
  ): Promise<void> {
    const requestResult = incomingRequestSchema.safeParse(parsed)
    if (!requestResult.success) {
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: { code: RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' },
      }
      writeLine(client.socket, response)
      return
    }

    const { method, params } = requestResult.data

    try {
      const result = await this._onRequest(method, params, client.id)
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        result,
      }
      writeLine(client.socket, response)
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : 'Internal error'
      const errCode = getErrorCode(err)
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: { code: errCode, message: errMessage },
      }
      writeLine(client.socket, response)
    }
  }

  private _handleClientNotification(client: ClientConnection, parsed: unknown): void {
    if (!this._onNotification) return

    const notifResult = incomingNotificationSchema.safeParse(parsed)
    if (!notifResult.success) return // Silently drop malformed notifications (no id to respond to)

    this._onNotification(notifResult.data.method, notifResult.data.params, client.id)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function writeLine(socket: Socket, data: unknown): void {
  if (socket.writable) {
    socket.write(`${superjson.stringify(data)}\n`)
  }
}

function getErrorCode(err: unknown): number {
  if (err instanceof Error) {
    // Map well-known error names to RPC codes
    if (err.name === 'DeviceNotReadyError') return RPC_ERRORS.DEVICE_NOT_FOUND
    if (err.name === 'NotSupportedError') return RPC_ERRORS.SERVICE_UNAVAILABLE
    if (err.name === 'TransportError') return RPC_ERRORS.OPERATION_FAILED
    if (err.name === 'TimeoutError') return RPC_ERRORS.OPERATION_FAILED
  }
  return RPC_ERRORS.INTERNAL_ERROR
}
