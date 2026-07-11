/**
 * ADB byte duplex over USB bulk endpoints (libusb).
 *
 * Speaks the ADB wire protocol directly to a device's ADB interface, bypassing
 * TCP entirely. This is the path for devices that expose a native ADB interface
 * over USB but no OS network stack we can reach (e.g. Qualcomm MSM8916 sticks on
 * macOS, whose RNDIS interface the OS ignores).
 *
 * The ADB interface is identified by its canonical USB descriptor
 * (class 0xFF / subclass 0x42 / protocol 0x01 -- Google's ADB signature), so no
 * per-device interface number is needed.
 *
 * The wire protocol (framing, CNXN handshake, stream multiplexing) lives in
 * wire.ts and is transport agnostic -- this only moves bytes.
 */

import { type Device, InEndpoint, type Interface, OutEndpoint, usb } from 'usb'

import { TransportError } from '../../errors.js'
import { acquireUsbDevice, releaseUsbDevice } from '../../transport/usb-device.js'
import type { AdbByteDuplex } from './wire.js'

// Google ADB interface descriptor (protocol.txt / adb source).
const ADB_INTERFACE_CLASS = 0xff
const ADB_INTERFACE_SUBCLASS = 0x42
const ADB_INTERFACE_PROTOCOL = 0x01

// IN endpoint poll: a few concurrent transfers, buffer >= wMaxPacketSize.
const POLL_TRANSFERS = 3
const POLL_SIZE = 16_384

interface AdbUsbInterface {
  readonly iface: Interface
  readonly inEp: InEndpoint
  readonly outEp: OutEndpoint
}

/** Locate the ADB interface and its bulk endpoints on an opened device. */
function findAdbInterface(device: Device, deviceLabel: string): AdbUsbInterface {
  for (const iface of device.interfaces ?? []) {
    const d = iface.descriptor
    if (
      d.bInterfaceClass !== ADB_INTERFACE_CLASS ||
      d.bInterfaceSubClass !== ADB_INTERFACE_SUBCLASS ||
      d.bInterfaceProtocol !== ADB_INTERFACE_PROTOCOL
    ) {
      continue
    }
    const bulk = usb.LIBUSB_TRANSFER_TYPE_BULK
    const inEp = iface.endpoints.find((ep) => ep.direction === 'in' && ep.transferType === bulk)
    const outEp = iface.endpoints.find((ep) => ep.direction === 'out' && ep.transferType === bulk)
    if (inEp instanceof InEndpoint && outEp instanceof OutEndpoint) {
      return { iface, inEp, outEp }
    }
  }
  throw new TransportError(
    `No ADB interface (0xFF/0x42/0x01) with bulk endpoints on ${deviceLabel}`,
  )
}

/**
 * Open the ADB interface on a USB device and return a byte duplex over it.
 *
 * Claims the ADB interface, detaches any kernel driver (Linux), and locates the
 * bulk IN/OUT endpoints. Polling begins when the wire layer registers its data
 * handler (via onData), before the CNXN handshake is sent.
 *
 * @throws TransportError if the device or ADB interface cannot be opened
 */
export function openAdbUsbBulkDuplex(vendorId: number, productId: number): AdbUsbBulkDuplex {
  const deviceLabel = `${vendorId.toString(16)}:${productId.toString(16)}`

  // Shared, ref-counted open: the AT adapter may hold the same physical device
  // on a different interface. See transport/usb-device.ts.
  const device = acquireUsbDevice(vendorId, productId)

  let found: AdbUsbInterface
  try {
    found = findAdbInterface(device, deviceLabel)
  } catch (err) {
    releaseUsbDevice(device)
    throw err
  }

  // Detach kernel driver if active (Linux only -- macOS/Windows have none).
  try {
    if (found.iface.isKernelDriverActive()) {
      found.iface.detachKernelDriver()
    }
  } catch {
    // Not supported on all platforms; safe to ignore.
  }

  try {
    found.iface.claim()
  } catch (err: unknown) {
    releaseUsbDevice(device)
    throw new TransportError(`Failed to claim ADB interface on ${deviceLabel}`, { cause: err })
  }

  return new AdbUsbBulkDuplex(device, found)
}

/**
 * AdbByteDuplex backed by USB bulk endpoints.
 *
 * write() is synchronous per the AdbByteDuplex contract, but USB transfers are
 * async -- so writes are enqueued and drained one transfer at a time, preserving
 * the message order the wire protocol depends on.
 */
export class AdbUsbBulkDuplex implements AdbByteDuplex {
  private readonly _device: Device
  private readonly _iface: Interface
  private readonly _inEp: InEndpoint
  private readonly _outEp: OutEndpoint

  private readonly _writeQueue: Buffer[] = []
  private _writing = false
  private _destroyed = false
  private _errorHandler: ((err: Error) => void) | undefined

  constructor(device: Device, iface: AdbUsbInterface) {
    this._device = device
    this._iface = iface.iface
    this._inEp = iface.inEp
    this._outEp = iface.outEp
  }

  onData(cb: (chunk: Buffer) => void): void {
    this._inEp.on('data', (chunk: Buffer) => cb(chunk))
    this._inEp.on('error', (err: Error) => {
      // A transfer error on the IN endpoint means the device dropped off the bus.
      this._errorHandler?.(new TransportError(`ADB USB read error: ${err.message}`))
    })
    this._inEp.startPoll(POLL_TRANSFERS, POLL_SIZE)
  }

  onClose(_cb: () => void): void {
    // USB has no distinct close event; disconnects surface as IN-endpoint errors
    // and are delivered through onError instead.
  }

  onError(cb: (err: Error) => void): void {
    this._errorHandler = cb
  }

  write(data: Buffer): void {
    if (this._destroyed) return
    this._writeQueue.push(data)
    this._pump()
  }

  private _pump(): void {
    if (this._writing || this._destroyed) return
    const next = this._writeQueue.shift()
    if (next === undefined) return
    this._writing = true
    this._outEp.transfer(next, (err) => {
      this._writing = false
      if (err) {
        this._errorHandler?.(new TransportError(`ADB USB write error: ${err.message}`))
        return
      }
      this._pump()
    })
  }

  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this._writeQueue.length = 0
    this._inEp.stopPoll(() => {
      this._inEp.removeAllListeners()
      this._iface.release(true, () => {
        releaseUsbDevice(this._device)
      })
    })
  }
}
