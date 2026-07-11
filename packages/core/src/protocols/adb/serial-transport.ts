/**
 * ADB serial transport.
 *
 * Implements the generic Transport interface over an ADB persistent stream,
 * providing bidirectional byte-level access to a device-internal serial port
 * (e.g. /dev/ttyS0 or a vendor virtual COM device like Balong appvcom).
 *
 * IMPORTANT: the serial device (appvcom) is a custom IPC channel to the
 * modem DSP, NOT a generic serial port. Read and write MUST use the same
 * file description (O_RDWR) — separate opens create independent channel
 * endpoints and responses get routed to the wrong one.
 *
 * Architecture: one persistent ADB shell stream with:
 * - Single O_RDWR fd to the device (`exec 3<>/dev/appvcom1`)
 * - Background reader: `cat <&3 &` (reads modem responses → stdout → ADB)
 * - Foreground writer: `while read; do echo >&3; done` (ADB stdin → device)
 * - EXIT trap: kills the background reader on shell exit, preventing orphans
 *
 * The EXIT trap is critical: without it, the background cat survives the
 * shell exit (busybox sh doesn't send SIGHUP to background jobs) and
 * becomes an orphan that steals data from the next session's reader.
 */

import { TransportError } from '../../errors.js'
import type { Transport } from '../../types.js'
import type { AdbStream } from './types.js'
import type { AdbConnectionLike } from './wire.js'

const OPEN_TIMEOUT_MS = 10_000

export interface AdbSerialTransportOptions {
  /** ADB connection to open the stream on. */
  readonly connection: AdbConnectionLike
  /** Device path on the remote system, e.g. '/dev/appvcom1'. */
  readonly devicePath: string
  /** Timeout for opening the ADB stream (default: 10s). */
  readonly openTimeoutMs?: number | undefined
  /**
   * Optional AT commands to send before opening the persistent stream.
   * Sent via `echo -e` directly to the device (bypasses PTY).
   * Useful for suppressing vendor URCs before establishing the main channel.
   */
  readonly preOpenCommands?: readonly string[] | undefined
}

/**
 * Build the shell command for bidirectional serial device access.
 *
 * Uses a single O_RDWR fd for both read and write — required by appvcom
 * which routes responses to the channel (file description) that sent the
 * command. Separate opens would lose responses.
 *
 * Cleanup:
 * - `fuser -k` kills all processes holding the device (stale sessions)
 * - `pidof cat | kill` fallback for busybox builds without fuser
 * - EXIT trap kills the background reader when the shell exits, preventing
 *   orphaned cat processes from stealing data in future sessions
 *
 * PTY workarounds (stty not available on embedded Linux):
 * - OUTPUT (onlcr): LF→CRLF. Line assembler handles doubled \r.
 * - INPUT (icrnl): \r→\n. Writer loop uses `read -r` (terminates on
 *   converted \n) then re-adds \r via echo -ne.
 */
function buildShellCommand(devicePath: string, preOpenCommands: readonly string[]): string {
  const preOpen = preOpenCommands.map((cmd) => `echo -e '${cmd}\\r' > ${devicePath}`)
  return [
    // Kill ALL processes holding the device file open.
    `busybox fuser -k ${devicePath} 2>/dev/null`,
    `for P in $(busybox pidof cat); do kill -9 $P 2>/dev/null; done`,
    // Pre-open commands (sent directly, bypassing PTY)
    ...preOpen,
    // Single O_RDWR fd — required by appvcom IPC channel semantics
    `exec 3<>${devicePath}`,
    // Cancel any pending AT input prompt (SMS send mode) and drain stale data
    `echo -ne '\\x1b' >&3`,
    'timeout 1 dd bs=4096 count=64 <&3 > /dev/null 2>&1 || true',
    // Background reader with tracked PID for cleanup
    'while true; do cat <&3; done &',
    'READER=$!',
    // EXIT trap: kill the background reader when the shell exits.
    // Without this, busybox sh leaves the background cat alive as an orphan.
    'trap "kill $READER 2>/dev/null" EXIT',
    // Foreground writer: PTY icrnl converts \r→\n, read -r terminates on \n,
    // echo -ne re-adds \r before writing to the device.
    'while IFS= read -r line; do echo -ne "$line\\r" >&3; done',
  ].join('\n')
}

export class AdbSerialTransport implements Transport {
  private readonly _connection: AdbConnectionLike
  private readonly _devicePath: string
  private readonly _openTimeoutMs: number
  private readonly _preOpenCommands: readonly string[]
  private _stream: AdbStream | undefined
  private _dataHandler: ((data: Uint8Array) => void) | undefined
  private _disconnectHandler: (() => void) | undefined
  private _open = false

  constructor(options: AdbSerialTransportOptions) {
    this._connection = options.connection
    this._devicePath = options.devicePath
    this._openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS
    this._preOpenCommands = options.preOpenCommands ?? []
  }

  async open(): Promise<void> {
    if (this._open) return

    const command = buildShellCommand(this._devicePath, this._preOpenCommands)
    const destination = `shell:${command}`

    this._stream = await this._connection.openStream(destination, this._openTimeoutMs)

    this._stream.onData((data) => {
      this._dataHandler?.(new Uint8Array(data))
    })

    this._stream.onClose(() => {
      this._open = false
      this._stream = undefined
      this._disconnectHandler?.()
    })

    this._open = true
  }

  async close(): Promise<void> {
    if (!this._open) return
    this._open = false
    this._stream?.close()
    this._stream = undefined
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this._stream === undefined) {
      throw new TransportError('ADB serial transport is not open')
    }
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
    await this._stream.write(buf)
  }

  onData(handler: (data: Uint8Array) => void): void {
    this._dataHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
  }

  get isOpen(): boolean {
    return this._open
  }
}
