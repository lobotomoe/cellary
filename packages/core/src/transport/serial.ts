import { SerialPort } from 'serialport'

import { TransportError } from '../errors.js'
import type { Transport } from '../types.js'

export interface SerialTransportOptions {
  /** Serial port path, e.g. '/dev/ttyUSB0' or 'COM3' */
  readonly path: string
  /** Baud rate. @default 115200 */
  readonly baudRate?: number | undefined
  /** Data bits. @default 8 */
  readonly dataBits?: 5 | 6 | 7 | 8 | undefined
  /** Stop bits. @default 1 */
  readonly stopBits?: 1 | 1.5 | 2 | undefined
  /** Parity. @default 'none' */
  readonly parity?: 'none' | 'even' | 'odd' | 'mark' | 'space' | undefined
}

/**
 * Transport over a physical serial port using the `serialport` npm package.
 *
 * @example
 * ```ts
 * const transport = new SerialTransport({ path: '/dev/ttyUSB0' })
 * await transport.open()
 * ```
 */
export class SerialTransport implements Transport {
  private readonly _options: SerialTransportOptions
  private _dataHandler: ((data: Uint8Array) => void) | null = null
  private _disconnectHandler: (() => void) | null = null
  private _port: SerialPort | null = null
  private _closingExplicitly = false

  constructor(options: SerialTransportOptions) {
    this._options = options
  }

  get isOpen(): boolean {
    return this._port?.isOpen ?? false
  }

  async open(): Promise<void> {
    if (this._port?.isOpen) {
      throw new TransportError('Transport is already open')
    }

    const { path, baudRate, dataBits, stopBits, parity } = this._options

    const port = new SerialPort({
      path,
      baudRate: baudRate ?? 115200,
      dataBits: dataBits ?? 8,
      stopBits: stopBits ?? 1,
      parity: parity ?? 'none',
      autoOpen: false,
    })

    // Wire data handler -- Buffer extends Uint8Array, so it satisfies our interface
    port.on('data', (chunk: Buffer) => {
      this._dataHandler?.(chunk)
    })

    // Handle unexpected close (USB disconnect, etc.)
    // Only fire the disconnect handler for unplanned closes, not explicit close() calls.
    port.on('close', () => {
      const wasExplicit = this._closingExplicitly
      this._port = null
      this._closingExplicitly = false
      if (!wasExplicit) {
        this._disconnectHandler?.()
      }
    })

    // Prevent Node.js crash on unhandled 'error' event.
    // Port errors surface naturally: disconnects trigger 'close',
    // and subsequent operations throw TransportError.
    port.on('error', () => {})

    await openPort(port, this._options.path)
    this._port = port
  }

  async close(): Promise<void> {
    const port = this._port
    if (!port?.isOpen) {
      throw new TransportError('Transport is not open')
    }

    this._closingExplicitly = true
    await closePort(port, this._options.path)
    this._port = null
  }

  async write(data: Uint8Array | string): Promise<void> {
    const port = this._port
    if (!port?.isOpen) {
      throw new TransportError('Transport is not open')
    }

    const buffer = typeof data === 'string' ? data : Buffer.from(data)
    await writeAndDrain(port, buffer, this._options.path)
  }

  onData(handler: (data: Uint8Array) => void): void {
    this._dataHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function openPort(port: SerialPort, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.open((err) => {
      if (err) {
        reject(classifyOpenError(err, path))
        return
      }
      resolve()
    })
  })
}

function isErrnoException(err: Error): err is NodeJS.ErrnoException {
  return 'code' in err
}

function classifyOpenError(err: Error, path: string): TransportError {
  const code = isErrnoException(err) ? err.code : undefined
  switch (code) {
    case 'EBUSY':
    case 'EAGAIN':
      return new TransportError(`Port ${path} is busy -- another application may be using it`, {
        cause: err,
      })
    case 'EACCES':
    case 'EPERM':
      return new TransportError(`Permission denied for ${path}`, { cause: err })
    case 'ENOENT':
    case 'ENXIO':
      return new TransportError(
        `Serial port ${path} not found -- check that the device is connected`,
        { cause: err },
      )
    default:
      return new TransportError(`Failed to open ${path}`, { cause: err })
  }
}

function closePort(port: SerialPort, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.close((err) => {
      if (err) {
        reject(new TransportError(`Failed to close ${path}`, { cause: err }))
        return
      }
      resolve()
    })
  })
}

function writeAndDrain(port: SerialPort, data: string | Buffer, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (writeErr) => {
      if (writeErr) {
        reject(classifyWriteError(writeErr, path))
        return
      }

      port.drain((drainErr) => {
        if (drainErr) {
          reject(classifyWriteError(drainErr, path))
          return
        }
        resolve()
      })
    })
  })
}

function classifyWriteError(err: Error, path: string): TransportError {
  const code = isErrnoException(err) ? err.code : undefined
  if (code === 'EIO' || code === 'ENXIO' || code === 'EBADF') {
    return new TransportError(`Device disconnected during write to ${path}`, { cause: err })
  }
  return new TransportError(`Write failed on ${path}`, { cause: err })
}
