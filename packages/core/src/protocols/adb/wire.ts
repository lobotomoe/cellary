/**
 * ADB wire protocol over TCP.
 *
 * Implements the ADB protocol needed for concurrent shell command execution:
 * CNXN handshake, OPEN streams, WRTE/OKAY flow control, CLSE teardown.
 *
 * Supports multiple concurrent streams via per-stream message routing.
 * Each openShell() call gets its own localId and receives only messages
 * addressed to that stream.
 *
 * No RSA authentication -- targets devices with insecure adbd (common on
 * embedded modem devices). If the device requires auth,
 * the handshake will fail with a clear error.
 *
 * Reference: Android ADB protocol specification
 * https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt
 */

import { createConnection, type Socket } from 'node:net'
import { TransportError } from '../../errors.js'
import {
  A_AUTH,
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_WRTE,
  ADB_CONNECT_TIMEOUT_MS,
  ADB_HEADER_SIZE,
  ADB_MAX_PAYLOAD,
  ADB_VERSION,
} from './constants.js'
import type { AdbMessage, AdbStream } from './types.js'

// ── Serialization ───────────────────────────────────────────────────────────

function checksum(data: Buffer): number {
  let sum = 0
  for (const byte of data) {
    sum += byte
  }
  return sum & 0xffff_ffff
}

function serializeHeader(command: number, arg0: number, arg1: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(ADB_HEADER_SIZE)
  header.writeUInt32LE(command, 0)
  header.writeUInt32LE(arg0, 4)
  header.writeUInt32LE(arg1, 8)
  header.writeUInt32LE(payload.length, 12)
  header.writeUInt32LE(checksum(payload), 16)
  // magic = command ^ 0xFFFFFFFF
  header.writeUInt32LE((command ^ 0xffff_ffff) >>> 0, 20)
  return header
}

function parseHeader(buf: Buffer): {
  command: number
  arg0: number
  arg1: number
  dataLength: number
} {
  const command = buf.readUInt32LE(0)
  const arg0 = buf.readUInt32LE(4)
  const arg1 = buf.readUInt32LE(8)
  const dataLength = buf.readUInt32LE(12)
  return { command, arg0, arg1, dataLength }
}

// ── Stream waiter ───────────────────────────────────────────────────────────

/**
 * Per-stream message waiter. Each active stream has one of these registered
 * in the connection's stream map. Incoming messages are routed by localId
 * (carried in the message's arg1 field).
 */
interface StreamWaiter {
  resolve(msg: AdbMessage): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Persistent stream handler. Unlike StreamWaiter (one-shot, promise-based),
 * a handler stays registered and receives all messages for the stream's
 * lifetime. Used by openStream() for long-running bidirectional streams.
 */
interface StreamHandler {
  onData: (data: Buffer) => void
  onClose: () => void
}

// ── Byte transport seam ─────────────────────────────────────────────────────

/**
 * Minimal byte-duplex the ADB wire protocol runs over.
 *
 * The wire protocol (framing, CNXN handshake, stream multiplexing) is transport
 * agnostic -- it only pushes and pulls bytes. Implementations wrap a concrete
 * transport: SocketDuplex (TCP), AdbUsbBulkDuplex (libusb bulk endpoints).
 *
 * write() must preserve call order: the protocol hands messages to write()
 * synchronously and relies on them reaching the wire in order. Transports with
 * async sends (USB) must queue internally rather than fire concurrently.
 */
export interface AdbByteDuplex {
  /** Send bytes. Preserves call order; may buffer internally. */
  write(data: Buffer): void
  /** Register the inbound byte handler. Called once during construction. */
  onData(cb: (chunk: Buffer) => void): void
  /** Register the transport-closed handler. Called once during construction. */
  onClose(cb: () => void): void
  /** Register the transport-error handler. Called once during construction. */
  onError(cb: (err: Error) => void): void
  /** Tear down the transport. */
  destroy(): void
}

// ── Connection interface ────────────────────────────────────────────────────

/**
 * Public surface of an ADB connection.
 *
 * Extracted so consumers (AdbSerialTransport, tests) depend on the interface
 * rather than the concrete class. This makes mock construction trivial
 * without `as unknown as AdbConnection` casts.
 */
export interface AdbConnectionLike {
  openShell(command: string, timeoutMs: number): Promise<string>
  openStream(destination: string, timeoutMs: number): Promise<AdbStream>
  onDisconnect(handler: () => void): void
  close(): Promise<void>
  readonly isOpen: boolean
}

// ── Connection ──────────────────────────────────────────────────────────────

/**
 * ADB connection over TCP.
 *
 * Manages the socket lifecycle and provides multiplexed shell command
 * execution. Multiple openShell() calls run concurrently -- each gets
 * its own ADB stream with independent message routing.
 */
export class AdbConnection implements AdbConnectionLike {
  private _io: AdbByteDuplex
  private _buffer = Buffer.alloc(0)
  private _disconnectHandler: (() => void) | undefined
  private _localId = 0
  private _closed = false

  /**
   * Per-stream waiters keyed by localId. When a message arrives, we look up
   * the stream by arg1 (which is our localId) and deliver the message.
   *
   * During handshake (before any stream exists), we use localId 0 as a
   * special "connection-level" waiter.
   */
  private readonly _streams = new Map<number, StreamWaiter>()

  /**
   * Persistent stream handlers keyed by localId. Unlike waiters (one-shot),
   * handlers stay registered for the stream's lifetime and receive all
   * WRTE/CLSE messages. Used by openStream() for long-running streams.
   *
   * Checked BEFORE waiters in routeMessage() -- a stream uses one pattern
   * or the other, never both.
   */
  private readonly _streamHandlers = new Map<number, StreamHandler>()

  /**
   * Messages that arrived for a stream that isn't currently waiting.
   * This handles the case where data arrives between two readStreamMessage()
   * calls on the same stream.
   */
  private readonly _pending = new Map<number, AdbMessage[]>()

  private constructor(io: AdbByteDuplex) {
    this._io = io
    io.onData((chunk) => this.onData(chunk))
    io.onClose(() => this.onClose())
    io.onError((err) => this.onError(err))
  }

  /**
   * Connect to an ADB device over TCP and perform the CNXN handshake.
   *
   * @param host - Device IP address (e.g. '192.168.8.1')
   * @param port - ADB port (default 5555)
   * @returns Connected and handshaked AdbConnection
   * @throws TransportError if connection or handshake fails
   */
  static async connect(host: string, port: number): Promise<AdbConnection> {
    const socket = await tcpConnect(host, port, ADB_CONNECT_TIMEOUT_MS)
    return AdbConnection.fromDuplex(new SocketDuplex(socket))
  }

  /**
   * Wrap an already-connected byte duplex (TCP socket, USB bulk pipe, ...) and
   * perform the CNXN handshake. Transport-agnostic entry point -- the TCP path
   * (connect) and the USB path both funnel through here.
   *
   * @throws TransportError if the handshake fails
   */
  static async fromDuplex(io: AdbByteDuplex): Promise<AdbConnection> {
    const conn = new AdbConnection(io)
    try {
      await conn.handshake()
    } catch (err) {
      conn._closed = true
      io.destroy()
      throw err
    }
    return conn
  }

  /**
   * Execute a shell command and return its output.
   *
   * Opens an ADB stream with `shell:command`, reads all WRTE payloads
   * until CLSE, and returns the concatenated output. Multiple calls run
   * concurrently -- each stream is independently multiplexed.
   */
  async openShell(command: string, timeoutMs: number): Promise<string> {
    if (this._closed) throw new TransportError('ADB connection is closed')

    const localId = ++this._localId
    const destination = `shell:${command}\0`
    const payload = Buffer.from(destination, 'utf-8')

    // Send OPEN
    this.send(A_OPEN, localId, 0, payload)

    // Wait for OKAY (stream accepted)
    const okay = await this.readStreamMessage(localId, timeoutMs)
    if (okay.command === A_CLSE) {
      this.cleanupStream(localId)
      throw new TransportError(`ADB shell command rejected: ${command}`)
    }
    if (okay.command !== A_OKAY) {
      this.cleanupStream(localId)
      throw new TransportError(`Expected OKAY, got 0x${okay.command.toString(16)}`)
    }

    const remoteId = okay.arg0

    // Read WRTE messages until CLSE
    const chunks: Buffer[] = []

    try {
      for (;;) {
        const msg = await this.readStreamMessage(localId, timeoutMs)

        if (msg.command === A_WRTE) {
          chunks.push(msg.payload)
          this.send(A_OKAY, localId, remoteId, Buffer.alloc(0))
          continue
        }

        if (msg.command === A_CLSE) {
          this.send(A_CLSE, localId, remoteId, Buffer.alloc(0))
          break
        }
      }
    } finally {
      this.cleanupStream(localId)
    }

    return Buffer.concat(chunks).toString('utf-8')
  }

  /**
   * Open a persistent bidirectional stream.
   *
   * Unlike openShell() (which blocks until the command finishes), openStream()
   * returns immediately after the OPEN/OKAY handshake and delivers data
   * incrementally via the onData handler. Used for long-running connections
   * like serial device access.
   *
   * The returned AdbStream shares the same TCP connection as one-shot shell
   * commands -- ADB multiplexes by localId.
   */
  async openStream(destination: string, timeoutMs: number): Promise<AdbStream> {
    if (this._closed) throw new TransportError('ADB connection is closed')

    const localId = ++this._localId
    const payload = Buffer.from(`${destination}\0`, 'utf-8')

    // Send OPEN
    this.send(A_OPEN, localId, 0, payload)

    // Wait for OKAY (stream accepted) using the one-shot waiter
    const okay = await this.readStreamMessage(localId, timeoutMs)
    if (okay.command === A_CLSE) {
      this.cleanupStream(localId)
      throw new TransportError(`ADB stream rejected: ${destination}`)
    }
    if (okay.command !== A_OKAY) {
      this.cleanupStream(localId)
      throw new TransportError(`Expected OKAY, got 0x${okay.command.toString(16)}`)
    }

    const remoteId = okay.arg0

    // Register persistent handler for this stream
    let dataHandler: ((data: Buffer) => void) | undefined
    let closeHandler: (() => void) | undefined

    this._streamHandlers.set(localId, {
      onData: (data) => dataHandler?.(data),
      onClose: () => {
        this._streamHandlers.delete(localId)
        closeHandler?.()
      },
    })

    const conn = this

    const stream: AdbStream = {
      remoteId,
      localId,
      onData(handler) {
        dataHandler = handler
      },
      onClose(handler) {
        closeHandler = handler
      },
      async write(data) {
        if (conn._closed) throw new TransportError('ADB connection is closed')
        conn.send(A_WRTE, localId, remoteId, data)
        // Wait for OKAY flow control acknowledgment
        const ack = await conn.readStreamMessage(localId, timeoutMs)
        if (ack.command !== A_OKAY) {
          throw new TransportError(`Expected OKAY after WRTE, got 0x${ack.command.toString(16)}`)
        }
      },
      close() {
        conn._streamHandlers.delete(localId)
        conn._pending.delete(localId)
        if (!conn._closed) {
          conn.send(A_CLSE, localId, remoteId, Buffer.alloc(0))
        }
      },
    }

    return stream
  }

  /** Register a handler for unexpected disconnection. */
  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
  }

  /** Whether the connection is still open. */
  get isOpen(): boolean {
    return !this._closed
  }

  /** Close the TCP connection and all active streams. */
  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    for (const [, handler] of this._streamHandlers) {
      handler.onClose()
    }
    this._streamHandlers.clear()
    this._io.destroy()
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async handshake(): Promise<void> {
    // Plain "host::" banner -- old adbd (Android 4.4 on embedded modems) predates
    // the "features=" negotiation (2016+) and wedges on it. cellary does not use
    // shell_v2 anyway (AdbShell parses exit codes via an echo-delimiter), so the
    // bare banner costs nothing and maximizes compatibility.
    const banner = Buffer.from('host::\0', 'utf-8')
    this.send(A_CNXN, ADB_VERSION, ADB_MAX_PAYLOAD, banner)

    // Handshake uses localId 0 (connection-level, not a stream)
    const response = await this.readStreamMessage(0, ADB_CONNECT_TIMEOUT_MS)
    this.cleanupStream(0)

    if (response.command === A_AUTH) {
      throw new TransportError(
        'ADB device requires authentication (RSA key exchange). ' +
          'cellary currently only supports insecure adbd connections. ' +
          'On the device, run: setprop ro.adb.secure 0',
      )
    }

    if (response.command !== A_CNXN) {
      throw new TransportError(
        `ADB handshake failed: expected CNXN, got 0x${response.command.toString(16)}`,
      )
    }
  }

  private send(command: number, arg0: number, arg1: number, payload: Buffer): void {
    if (this._closed) return
    // Header and payload go as SEPARATE writes. Over USB (FunctionFS adbd) the
    // gadget reads the 24-byte header and the payload as distinct transfers, so
    // a single combined bulk transfer strands the payload and wedges the peer.
    // For TCP these are two writes onto the same stream -- no behavior change.
    this._io.write(serializeHeader(command, arg0, arg1, payload))
    if (payload.length > 0) {
      this._io.write(payload)
    }
  }

  /**
   * Wait for the next message addressed to the given stream.
   *
   * ADB routes messages by localId:
   *   - OKAY/WRTE/CLSE carry our localId in arg1
   *   - CNXN/AUTH (handshake) have arg1=0, routed to stream 0
   *
   * If a message for this stream is already queued in _pending, returns
   * immediately. Otherwise, registers a waiter resolved by onData().
   */
  private readStreamMessage(localId: number, timeoutMs: number): Promise<AdbMessage> {
    return new Promise<AdbMessage>((resolve, reject) => {
      // Check pending queue first
      const queued = this.takePending(localId)
      if (queued !== undefined) {
        resolve(queued)
        return
      }

      // Try parsing buffered data -- messages might be waiting
      this.drainBuffer()

      const queuedAfterDrain = this.takePending(localId)
      if (queuedAfterDrain !== undefined) {
        resolve(queuedAfterDrain)
        return
      }

      // Register a waiter
      const timer = setTimeout(() => {
        this._streams.delete(localId)
        reject(new TransportError('ADB message read timeout'))
      }, timeoutMs)

      this._streams.set(localId, {
        resolve: (msg) => {
          clearTimeout(timer)
          this._streams.delete(localId)
          resolve(msg)
        },
        reject: (err) => {
          clearTimeout(timer)
          this._streams.delete(localId)
          reject(err)
        },
        timer,
      })
    })
  }

  /** Take the first pending message for a stream, if any. */
  private takePending(localId: number): AdbMessage | undefined {
    const queue = this._pending.get(localId)
    if (queue === undefined || queue.length === 0) return undefined
    const msg = queue.shift()
    if (queue.length === 0) this._pending.delete(localId)
    return msg
  }

  /** Remove all state for a stream. */
  private cleanupStream(localId: number): void {
    this._streams.delete(localId)
    this._streamHandlers.delete(localId)
    this._pending.delete(localId)
  }

  /**
   * Route a parsed message to the correct stream.
   *
   * Routing key: CNXN/AUTH -> stream 0, everything else -> arg1 (our localId).
   */
  private routeMessage(msg: AdbMessage): void {
    const targetId = msg.command === A_CNXN || msg.command === A_AUTH ? 0 : msg.arg1

    // Persistent stream handlers take priority (used by openStream)
    const handler = this._streamHandlers.get(targetId)
    if (handler !== undefined) {
      if (msg.command === A_WRTE) {
        handler.onData(msg.payload)
        // Send OKAY flow control acknowledgment
        this.send(A_OKAY, targetId, msg.arg0, Buffer.alloc(0))
        return
      }
      if (msg.command === A_CLSE) {
        handler.onClose()
        return
      }
      // OKAY messages for streaming writes fall through to waiter
    }

    // One-shot waiter (used by openShell and openStream.write)
    const waiter = this._streams.get(targetId)
    if (waiter !== undefined) {
      waiter.resolve(msg)
      return
    }

    // No handler or waiter -- queue for later pickup
    let queue = this._pending.get(targetId)
    if (queue === undefined) {
      queue = []
      this._pending.set(targetId, queue)
    }
    queue.push(msg)
  }

  /** Parse all complete messages from the buffer and route them. */
  private drainBuffer(): void {
    for (;;) {
      const msg = this.tryParseMessage()
      if (msg === undefined) break
      this.routeMessage(msg)
    }
  }

  private onData(chunk: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, chunk])
    this.drainBuffer()
  }

  private tryParseMessage(): AdbMessage | undefined {
    if (this._buffer.length < ADB_HEADER_SIZE) return undefined

    const header = parseHeader(this._buffer)
    const totalLength = ADB_HEADER_SIZE + header.dataLength

    if (this._buffer.length < totalLength) return undefined

    const payload = this._buffer.subarray(ADB_HEADER_SIZE, totalLength)
    this._buffer = this._buffer.subarray(totalLength)

    return {
      command: header.command,
      arg0: header.arg0,
      arg1: header.arg1,
      payload: Buffer.from(payload),
    }
  }

  private onClose(): void {
    if (this._closed) return
    this._closed = true
    const err = new TransportError('ADB connection closed unexpectedly')
    for (const [, waiter] of this._streams) {
      waiter.reject(err)
    }
    this._streams.clear()
    for (const [, handler] of this._streamHandlers) {
      handler.onClose()
    }
    this._streamHandlers.clear()
    this._disconnectHandler?.()
  }

  private onError(err: Error): void {
    if (this._closed) return
    this._closed = true
    const transportErr = new TransportError(`ADB socket error: ${err.message}`)
    for (const [, waiter] of this._streams) {
      waiter.reject(transportErr)
    }
    this._streams.clear()
    for (const [, handler] of this._streamHandlers) {
      handler.onClose()
    }
    this._streamHandlers.clear()
    this._disconnectHandler?.()
  }
}

// ── TCP byte duplex ─────────────────────────────────────────────────────────

/** AdbByteDuplex backed by a node.js TCP socket. Keeps the TCP path unchanged. */
class SocketDuplex implements AdbByteDuplex {
  constructor(private readonly _socket: Socket) {}

  write(data: Buffer): void {
    this._socket.write(data)
  }

  onData(cb: (chunk: Buffer) => void): void {
    this._socket.on('data', cb)
  }

  onClose(cb: () => void): void {
    this._socket.on('close', cb)
  }

  onError(cb: (err: Error) => void): void {
    this._socket.on('error', cb)
  }

  destroy(): void {
    this._socket.destroy()
  }
}

// ── TCP helper ──────────────────────────────────────────────────────────────

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: timeoutMs })

    const onConnect = () => {
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      socket.setTimeout(0) // clear connect timeout
      resolve(socket)
    }

    const onError = (err: Error) => {
      socket.removeListener('connect', onConnect)
      socket.removeListener('timeout', onTimeout)
      socket.destroy()
      reject(new TransportError(`ADB TCP connect failed (${host}:${port}): ${err.message}`))
    }

    const onTimeout = () => {
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      socket.destroy()
      reject(new TransportError(`ADB TCP connect timeout (${host}:${port})`))
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
  })
}
