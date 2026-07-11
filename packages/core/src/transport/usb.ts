import type { Device, Interface } from 'usb'
import { InEndpoint, OutEndpoint, usb } from 'usb'
import { TransportError } from '../errors.js'
import type { Transport } from '../types.js'
import { acquireUsbDevice, forceCloseUsbDevice, releaseUsbDevice } from './usb-device.js'

const DEFAULT_POLL_TRANSFERS = 3
const DEFAULT_POLL_SIZE = 4096

// CDC ACM class request codes
const CDC_SET_LINE_CODING = 0x20
const CDC_SET_CONTROL_LINE_STATE = 0x22
const CDC_REQUEST_TYPE = 0x21 // host-to-device, class, interface

// DTR/RTS bit positions in SET_CONTROL_LINE_STATE wValue
const SIGNAL_DTR = 0x01
const SIGNAL_RTS = 0x02

const DEFAULT_BAUD = 115200

export interface UsbTransportOptions {
  /** USB vendor ID, e.g. 0x12d1 for Huawei */
  readonly vendorId: number
  /** USB product ID, e.g. 0x1506 for E3372 in stick mode */
  readonly productId: number
  /** Which USB interface to claim for AT commands */
  readonly interfaceNumber: number
  /**
   * Assert DTR/RTS via CDC ACM control transfers on open.
   *
   * Required by Qualcomm serial_smd interfaces and most USB CDC ACM
   * serial ports. Without DTR, the device silently drops all data.
   *
   * When enabled, sends SET_LINE_CODING (115200 8N1) and
   * SET_CONTROL_LINE_STATE (DTR+RTS) during open(), and drops DTR
   * during close(). Control transfer failures are silently ignored --
   * not all devices implement the CDC ACM class requests on
   * vendor-specific interfaces.
   *
   * @default false
   */
  readonly assertDtr?: boolean | undefined
  /** Baud rate for SET_LINE_CODING. Only used when assertDtr is true. @default 115200 */
  readonly baudRate?: number | undefined
  /** Number of concurrent IN transfers. @default 3 */
  readonly pollTransfers?: number | undefined
  /** IN transfer buffer size in bytes. @default 4096 */
  readonly pollSize?: number | undefined
}

/**
 * Transport over USB bulk endpoints using the `usb` (libusb) npm package.
 *
 * Communicates directly with the modem's USB interfaces, bypassing OS
 * serial drivers entirely. This is the cross-platform path for devices
 * whose vendor-specific interfaces lack OS serial driver support (e.g.,
 * Huawei E3372 on macOS).
 *
 * @example
 * ```ts
 * const transport = new UsbTransport({
 *   vendorId: 0x12d1,
 *   productId: 0x1506,
 *   interfaceNumber: 1,
 * })
 * await transport.open()
 * ```
 */
export class UsbTransport implements Transport {
  private readonly _options: UsbTransportOptions
  private _dataHandler: ((data: Uint8Array) => void) | null = null
  private _disconnectHandler: (() => void) | null = null

  private _device: Device | null = null
  private _interface: Interface | null = null
  private _inEndpoint: InEndpoint | null = null
  private _outEndpoint: OutEndpoint | null = null

  constructor(options: UsbTransportOptions) {
    this._options = options
  }

  get isOpen(): boolean {
    return this._device !== null && this._inEndpoint !== null
  }

  async open(): Promise<void> {
    if (this._device !== null) {
      throw new TransportError('Transport is already open')
    }

    const { vendorId, productId, interfaceNumber } = this._options
    const vidHex = vendorId.toString(16)
    const pidHex = productId.toString(16)
    const deviceLabel = `${vidHex}:${pidHex}`

    // Shared, ref-counted open: another adapter (e.g. ADB) may hold the same
    // physical device on a different interface. See usb-device.ts.
    const device = acquireUsbDevice(vendorId, productId)

    const iface = device.interface(interfaceNumber)
    if (!iface) {
      releaseUsbDevice(device)
      throw new TransportError(
        `USB interface ${interfaceNumber} not found on device ${deviceLabel}`,
      )
    }

    // Detach kernel driver if active (Linux only -- macOS/Windows don't have one)
    try {
      if (iface.isKernelDriverActive()) {
        iface.detachKernelDriver()
      }
    } catch {
      // Not supported on all platforms
    }

    try {
      iface.claim()
    } catch (err: unknown) {
      releaseUsbDevice(device)
      throw new TransportError(
        `Failed to claim USB interface ${interfaceNumber} on ${deviceLabel}`,
        { cause: err },
      )
    }

    // Assert DTR/RTS if requested (CDC ACM initialization)
    if (this._options.assertDtr) {
      await this._sendCdcAcmInit(device, interfaceNumber)
    }

    // Find bulk IN and OUT endpoints
    const bulkType = usb.LIBUSB_TRANSFER_TYPE_BULK
    const inEp = iface.endpoints.find((ep) => ep.direction === 'in' && ep.transferType === bulkType)
    const outEp = iface.endpoints.find(
      (ep) => ep.direction === 'out' && ep.transferType === bulkType,
    )

    if (!inEp || !outEp) {
      iface.release(() => {})
      releaseUsbDevice(device)
      throw new TransportError(
        `No bulk IN/OUT endpoints found on interface ${interfaceNumber} of ${deviceLabel}`,
      )
    }

    if (!(inEp instanceof InEndpoint) || !(outEp instanceof OutEndpoint)) {
      iface.release(() => {})
      releaseUsbDevice(device)
      throw new TransportError(
        `Unexpected endpoint types on interface ${interfaceNumber} of ${deviceLabel}`,
      )
    }

    // Wire data handler before starting poll
    inEp.on('data', (chunk: Buffer) => {
      this._dataHandler?.(chunk)
    })

    // Handle USB disconnect / transfer errors
    inEp.on('error', () => {
      // LIBUSB_ERROR_NO_DEVICE (-4) or LIBUSB_ERROR_IO (-1) indicate disconnect
      this._handleDisconnect()
    })

    // Start polling the IN endpoint for incoming data
    const pollTransfers = this._options.pollTransfers ?? DEFAULT_POLL_TRANSFERS
    const pollSize = this._options.pollSize ?? DEFAULT_POLL_SIZE
    inEp.startPoll(pollTransfers, pollSize)

    this._device = device
    this._interface = iface
    this._inEndpoint = inEp
    this._outEndpoint = outEp
  }

  async close(): Promise<void> {
    const inEndpoint = this._inEndpoint
    const iface = this._interface
    const device = this._device
    if (!device || !iface || !inEndpoint) {
      throw new TransportError('Transport is not open')
    }

    // Drop DTR before closing
    if (this._options.assertDtr && device) {
      await this._sendControlLineSafe(device, this._options.interfaceNumber, 0)
    }

    // Stop polling (with timeout — device may be unresponsive after disconnect)
    const STOP_POLL_TIMEOUT_MS = 5_000
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_POLL_TIMEOUT_MS)
      inEndpoint.stopPoll(() => {
        clearTimeout(timer)
        resolve()
      })
    })

    inEndpoint.removeAllListeners()

    // Release interface
    await new Promise<void>((resolve, reject) => {
      iface.release((err) => {
        if (err) {
          reject(new TransportError('Failed to release USB interface', { cause: err }))
          return
        }
        resolve()
      })
    })

    releaseUsbDevice(device)
    this._nullify()
  }

  async write(data: Uint8Array | string): Promise<void> {
    const outEndpoint = this._outEndpoint
    if (!outEndpoint || !this._device) {
      throw new TransportError('Transport is not open')
    }

    const buffer = Buffer.from(data)

    await new Promise<void>((resolve, reject) => {
      outEndpoint.transfer(buffer, (err) => {
        if (err) {
          reject(new TransportError('USB write failed', { cause: err }))
          return
        }
        resolve()
      })
    })
  }

  onData(handler: (data: Uint8Array) => void): void {
    this._dataHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
  }

  /**
   * Perform a USB bus reset on the device.
   *
   * This is the software equivalent of unplugging and re-plugging the device.
   * The modem's firmware restarts, clearing any stuck AT command state.
   *
   * After reset, the transport is closed. The caller must re-open() it
   * once the device re-enumerates on the USB bus (typically ~2-3 seconds).
   *
   * Requires elevated privileges (root/sudo) on most platforms.
   */
  async reset(): Promise<void> {
    const device = this._device
    if (!device) {
      throw new TransportError('Transport is not open — cannot reset')
    }

    const CLEANUP_TIMEOUT_MS = 2_000

    // Best-effort cleanup: stop polling and release interface.
    // Both have aggressive timeouts — when the modem is stuck, pending
    // USB transfers may never complete, so we can't wait forever.
    const inEndpoint = this._inEndpoint
    if (inEndpoint) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
        inEndpoint.stopPoll(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      inEndpoint.removeAllListeners()
    }

    const iface = this._interface
    if (iface) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
        iface.release(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }

    // Perform the actual USB bus reset.
    // This may fail with LIBUSB_ERROR_NOT_FOUND if the device already
    // disconnected, or with LIBUSB_ERROR_NOT_SUPPORTED on some platforms.
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new TransportError('USB device reset timed out'))
        }, 5_000)
        device.reset((err) => {
          clearTimeout(timer)
          if (err) {
            reject(new TransportError('USB device reset failed', { cause: err }))
            return
          }
          resolve()
        })
      })
    } finally {
      // reset() tears the device down for every holder; drop the shared handle.
      forceCloseUsbDevice(device)
      this._nullify()
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _handleDisconnect(): void {
    this._nullify()
    this._disconnectHandler?.()
  }

  private _nullify(): void {
    this._device = null
    this._interface = null
    this._inEndpoint = null
    this._outEndpoint = null
  }

  /**
   * Send CDC ACM initialization: SET_LINE_CODING + SET_CONTROL_LINE_STATE.
   * Failures are silently ignored -- not all USB serial interfaces
   * implement CDC ACM class requests.
   */
  private async _sendCdcAcmInit(device: Device, ifaceNum: number): Promise<void> {
    const baud = this._options.baudRate ?? DEFAULT_BAUD

    // SET_LINE_CODING: 7-byte payload (baud LE, stop bits, parity, data bits)
    const lineCoding = Buffer.alloc(7)
    lineCoding.writeUInt32LE(baud, 0)
    lineCoding.writeUInt8(0, 4) // 1 stop bit
    lineCoding.writeUInt8(0, 5) // no parity
    lineCoding.writeUInt8(8, 6) // 8 data bits

    await this._sendControlSafe(device, CDC_SET_LINE_CODING, 0, ifaceNum, lineCoding)
    await this._sendControlLineSafe(device, ifaceNum, SIGNAL_DTR | SIGNAL_RTS)
  }

  /** Send SET_CONTROL_LINE_STATE with given signal flags. Ignores errors. */
  private async _sendControlLineSafe(
    device: Device,
    ifaceNum: number,
    signals: number,
  ): Promise<void> {
    await this._sendControlSafe(
      device,
      CDC_SET_CONTROL_LINE_STATE,
      signals,
      ifaceNum,
      Buffer.alloc(0),
    )
  }

  /** Send a USB class control transfer, ignoring failures. */
  private _sendControlSafe(
    device: Device,
    bRequest: number,
    wValue: number,
    wIndex: number,
    data: Buffer,
  ): Promise<void> {
    return new Promise((resolve) => {
      device.controlTransfer(CDC_REQUEST_TYPE, bRequest, wValue, wIndex, data, () => {
        // Ignore errors -- device may not support CDC ACM class requests
        resolve()
      })
    })
  }
}
