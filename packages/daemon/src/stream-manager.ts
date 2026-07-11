/**
 * Stream manager: manages active bidirectional streams between IPC clients and devices.
 *
 * Parallel to EventBridge -- a daemon-level component that uses IpcServer
 * for communication. Bridges IPC stream messages to device InteractiveStreams.
 *
 * Handles cleanup on: client disconnect, device removal/reset, daemon shutdown.
 */

import type { InteractiveStream, Logger } from 'cellary'

import type { JsonRpcNotification } from './ipc/protocol.js'
import type { IpcServer } from './ipc/server.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface ManagedStream {
  readonly streamId: string
  readonly clientId: string
  readonly deviceId: string
  readonly stream: InteractiveStream
}

// ── Stream Manager ─────────────────────────────────────────────────────────

export class StreamManager {
  private readonly _server: IpcServer
  private readonly _log: Logger
  private readonly _streams = new Map<string, ManagedStream>()
  private _nextId = 1

  constructor(server: IpcServer, logger: Logger) {
    this._server = server
    this._log = logger
  }

  /**
   * Register a device stream and wire bidirectional data forwarding.
   * Returns the assigned streamId.
   */
  openStream(clientId: string, deviceId: string, stream: InteractiveStream): string {
    const streamId = `s-${this._nextId++}`

    const entry: ManagedStream = { streamId, clientId, deviceId, stream }
    this._streams.set(streamId, entry)

    // Device -> client: forward data as base64 notifications
    stream.onData((data: Buffer) => {
      // Stream may have been removed by cleanup before this callback fires
      if (!this._streams.has(streamId)) return

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'stream.data',
        params: { streamId, data: data.toString('base64') },
      }
      this._server.notify(clientId, notification)
    })

    // Device -> client: forward close
    stream.onClose(() => {
      if (!this._streams.has(streamId)) return

      this._streams.delete(streamId)
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'stream.close',
        params: { streamId },
      }
      this._server.notify(clientId, notification)
      this._log.debug('Stream closed by device', { streamId, deviceId })
    })

    this._log.debug('Stream opened', { streamId, clientId, deviceId })
    return streamId
  }

  /** Forward client data to the device stream. */
  handleData(clientId: string, streamId: string, base64Data: string): void {
    const entry = this._streams.get(streamId)
    if (!entry || entry.clientId !== clientId) return

    const buffer = Buffer.from(base64Data, 'base64')
    entry.stream.write(buffer).catch((err: unknown) => {
      this._log.error('Stream write failed', { streamId, error: err })
    })
  }

  /** Close a stream by client request. */
  handleClose(clientId: string, streamId: string): void {
    const entry = this._streams.get(streamId)
    if (!entry || entry.clientId !== clientId) return

    this._streams.delete(streamId)
    entry.stream.close()
    this._log.debug('Stream closed by client', { streamId })
  }

  /** Close all streams for a client (called on client disconnect). */
  removeClient(clientId: string): void {
    for (const [streamId, entry] of this._streams) {
      if (entry.clientId === clientId) {
        this._streams.delete(streamId)
        entry.stream.close()
        this._log.debug('Stream closed (client disconnected)', { streamId, clientId })
      }
    }
  }

  /** Close all streams for a device (called on device removal/reset). */
  removeDevice(deviceId: string): void {
    for (const [streamId, entry] of this._streams) {
      if (entry.deviceId === deviceId) {
        this._streams.delete(streamId)
        entry.stream.close()

        // Notify the client that the stream was closed
        const notification: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'stream.close',
          params: { streamId },
        }
        this._server.notify(entry.clientId, notification)
        this._log.debug('Stream closed (device removed)', { streamId, deviceId })
      }
    }
  }

  /** Close all streams (called on daemon shutdown). */
  closeAll(): void {
    for (const [streamId, entry] of this._streams) {
      entry.stream.close()
      this._log.debug('Stream closed (shutdown)', { streamId })
    }
    this._streams.clear()
  }
}
