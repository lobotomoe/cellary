/**
 * CDC-ECM USB Transport — userspace networking for USB devices that
 * expose CDC Ethernet (ECM) with no usable OS network stack.
 *
 * Uses tcpip (lwIP WASM) as the TCP/IP stack on top of raw Ethernet
 * frames exchanged over USB bulk endpoints. No root required.
 *
 * Architecture:
 *   USB bulk endpoints
 *       ↕ raw Ethernet frames (bridge.ts)
 *   tcpip TapInterface (L2 Ethernet)
 *       ↕ lwIP (ARP, IP, TCP)
 *   stack.connectTcp() → raw TCP socket
 */
import type { TapInterface, TcpConnection } from 'tcpip'
import { createStack } from 'tcpip'
import type { Device, Interface } from 'usb'
import { findByIds, InEndpoint, OutEndpoint, usb } from 'usb'

import { TransportError } from '../../errors.js'
import { deriveLocalMac, parseIpv4Cidr } from '../net-address.js'
import type { UsbNetTransport } from '../usb-net.js'
import { EcmBridge } from './bridge.js'
import { splitFinData } from './frame-fix.js'

export type { TcpConnection } from 'tcpip'

export interface EcmTransportOptions {
  /** USB vendor ID */
  readonly vendorId: number
  /** USB product ID */
  readonly productId: number
  /** CDC Communication (control) interface number */
  readonly controlInterface?: number | undefined
  /** CDC Data interface number */
  readonly dataInterface?: number | undefined
  /**
   * Alternate setting on the data interface that activates bulk endpoints.
   * ECM data interfaces typically have alt 0 (no endpoints) and alt 1 (active).
   */
  readonly dataAltSetting?: number | undefined
  /** IP address for the local (host) side, CIDR notation */
  readonly localIp?: string | undefined
  /** Gateway IP (the device's IP address) */
  readonly gatewayIp?: string | undefined
}

const DEFAULT_CONTROL_INTERFACE = 0
const DEFAULT_DATA_INTERFACE = 1
const DEFAULT_DATA_ALT_SETTING = 1
const DEFAULT_LOCAL_IP = '192.168.1.100/24'
const DEFAULT_GATEWAY_IP = '192.168.1.1'

/**
 * Delay (ms) before delivering a split FIN frame after the data frame.
 * Gives tcpip.js time to process the data and enqueue it in the
 * ReadableStream before the FIN triggers connection close.
 */
const FIN_DELAY_MS = 50

/** Maximum time (ms) to wait for open() to complete (USB + WASM init) */
const OPEN_TIMEOUT_MS = 15_000

/**
 * Provides TCP connectivity to a USB device via CDC-ECM.
 *
 * After open(), use connectTcp() to establish TCP connections to
 * the device's IP address (typically 192.168.1.1).
 *
 * @example
 * ```ts
 * const transport = new EcmTransport({
 *   vendorId: 0x1bbb,
 *   productId: 0x0908,
 * })
 * await transport.open()
 * const conn = await transport.connectTcp('192.168.1.1', 80)
 * // use conn.readable / conn.writable for HTTP
 * await transport.close()
 * ```
 */
export class EcmTransport implements UsbNetTransport {
  private readonly _options: EcmTransportOptions

  private _device: Device | null = null
  private _controlIface: Interface | null = null
  private _dataIface: Interface | null = null
  private _bridge: EcmBridge | null = null
  private _tap: TapInterface | null = null
  private _stack: Awaited<ReturnType<typeof createStack>> | null = null
  private _tapWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  private _readerCancelled = false
  private _originalConsoleError: typeof console.error | null = null
  /**
   * Set when the stack-to-device pipe died while the transport was still open
   * (e.g. a bulk write failed after the device dropped off the bus). The tunnel
   * is half-dead from then on: frames still arrive but nothing can be sent, so
   * every later request would hang until its read timeout. Recording the
   * failure lets connectTcp() fail immediately with the real cause instead.
   */
  private _pipeFailure: TransportError | null = null

  constructor(options: EcmTransportOptions) {
    this._options = options
  }

  get isOpen(): boolean {
    return this._bridge !== null && this._stack !== null && this._pipeFailure === null
  }

  get vendorId(): number {
    return this._options.vendorId
  }

  get productId(): number {
    return this._options.productId
  }

  get gatewayIp(): string {
    return this._options.gatewayIp ?? DEFAULT_GATEWAY_IP
  }

  async open(): Promise<void> {
    if (this._device !== null) {
      throw new TransportError('ECM transport is already open')
    }

    // Race the actual init against a deadline so a stuck USB transfer
    // or WASM load doesn't hang the process forever.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new TransportError(`ECM transport open timed out after ${OPEN_TIMEOUT_MS}ms`)),
        OPEN_TIMEOUT_MS,
      )
    })

    await Promise.race([this._open(), timeout])
  }

  private async _open(): Promise<void> {
    const { vendorId, productId } = this._options
    const label = `${vendorId.toString(16)}:${productId.toString(16)}`

    // ── Find and open USB device ────────────────────────────────────────

    const device = findByIds(vendorId, productId)
    if (!device) {
      throw new TransportError(`USB device not found: ${label}`)
    }

    try {
      device.open()
    } catch (err: unknown) {
      throw new TransportError(`Failed to open USB device ${label}`, { cause: err })
    }

    const controlIfNum = this._options.controlInterface ?? DEFAULT_CONTROL_INTERFACE
    const dataIfNum = this._options.dataInterface ?? DEFAULT_DATA_INTERFACE
    const dataAlt = this._options.dataAltSetting ?? DEFAULT_DATA_ALT_SETTING

    // ── Claim interfaces ────────────────────────────────────────────────

    const controlIface = device.interface(controlIfNum)
    const dataIface = device.interface(dataIfNum)

    if (!controlIface || !dataIface) {
      device.close()
      throw new TransportError(`ECM interfaces ${controlIfNum}/${dataIfNum} not found on ${label}`)
    }

    for (const iface of [controlIface, dataIface]) {
      try {
        if (iface.isKernelDriverActive()) iface.detachKernelDriver()
      } catch {
        // Not supported on all platforms (macOS doesn't support this for ECM)
      }
      try {
        iface.claim()
      } catch (err: unknown) {
        device.close()
        throw new TransportError(`Failed to claim interface ${iface.interfaceNumber} on ${label}`, {
          cause: err,
        })
      }
    }

    // ── Select alt setting to activate bulk endpoints ────────────────────
    // ECM data interface alt 0 has no endpoints; alt 1 has bulk IN + OUT.

    try {
      await setAltSetting(dataIface, dataAlt)
    } catch (err: unknown) {
      this._releaseAndClose(controlIface, dataIface, device)
      throw new TransportError(
        `Failed to set alt setting ${dataAlt} on data interface of ${label}`,
        { cause: err },
      )
    }

    // ── Find bulk endpoints on data interface ───────────────────────────

    const bulkType = usb.LIBUSB_TRANSFER_TYPE_BULK
    const inEp = dataIface.endpoints.find(
      (ep) => ep.direction === 'in' && ep.transferType === bulkType,
    )
    const outEp = dataIface.endpoints.find(
      (ep) => ep.direction === 'out' && ep.transferType === bulkType,
    )

    if (!inEp || !outEp || !(inEp instanceof InEndpoint) || !(outEp instanceof OutEndpoint)) {
      this._releaseAndClose(controlIface, dataIface, device)
      throw new TransportError(`No bulk endpoints found on data interface of ${label}`)
    }

    // ── Read device MAC address ─────────────────────────────────────────

    const bridge = new EcmBridge(device, controlIfNum, inEp, outEp)
    let deviceMac: string
    try {
      deviceMac = await bridge.readMac()
    } catch (err: unknown) {
      this._releaseAndClose(controlIface, dataIface, device)
      throw new TransportError(`Failed to read ECM MAC address on ${label}`, { cause: err })
    }

    // ── Create TCP/IP stack ─────────────────────────────────────────────

    const localIp = this._options.localIp ?? DEFAULT_LOCAL_IP
    const stack = await createStack()
    const localMac = deriveLocalMac(deviceMac)

    const tap = await stack.createTapInterface({
      mac: localMac,
      ip: parseIpv4Cidr(localIp),
    })

    // ── Wire bridge ↔ tcpip ─────────────────────────────────────────────

    // Device → tcpip: USB bulk IN frames go into the stack
    //
    // Workaround for tcpip.js@0.3.3: when a TCP segment carries both
    // payload and FIN, the readable stream is errored before the payload
    // is delivered. We split such segments into data-only + FIN-only
    // so the data is processed before the connection close signal.
    // See frame-fix.ts for details.
    const tapWriter = tap.writable.getWriter()
    const localMacBytes = parseMacBytes(localMac)

    bridge.onFrame((ethFrame) => {
      // Drop frames not addressed to us (multicast, IPv6 neighbor discovery, etc.)
      // tcpip.js logs console.error for frames on unknown tap interfaces,
      // and these frames are useless to us anyway.
      if (!isFrameForUs(ethFrame, localMacBytes)) return

      const split = splitFinData(ethFrame)
      if (split) {
        tapWriter.write(split.dataFrame).catch(() => {})
        setTimeout(() => {
          tapWriter.write(split.finFrame).catch(() => {})
        }, FIN_DELAY_MS)
      } else {
        tapWriter.write(ethFrame).catch(() => {})
      }
    })

    // tcpip → Device: stack's outgoing frames go to USB bulk OUT
    this._readerCancelled = false
    this._pipeFailure = null
    this._pipeReadableToBridge(tap.readable, bridge).catch((err: unknown) => {
      this._pipeFailure = new TransportError('ECM tunnel failed: device stopped accepting frames', {
        cause: err,
      })
    })

    // Suppress tcpip.js console.error("received frame on unknown tap interface").
    // This fires for frames that lwIP routes to an internal interface ID not in
    // tcpip's JS-side map — a harmless race condition we can't fix externally.
    this._originalConsoleError = console.error
    const originalError = this._originalConsoleError
    console.error = (...args: Parameters<typeof console.error>) => {
      if (args[0] === 'received frame on unknown tap interface') return
      originalError.apply(console, args)
    }

    bridge.startReceiving()

    // Store state
    this._device = device
    this._controlIface = controlIface
    this._dataIface = dataIface
    this._bridge = bridge
    this._tap = tap
    this._stack = stack
    this._tapWriter = tapWriter
  }

  /** Establish a TCP connection through the ECM tunnel */
  async connectTcp(host: string, port: number): Promise<TcpConnection> {
    if (!this._stack) {
      throw new TransportError('ECM transport is not open')
    }
    if (this._pipeFailure !== null) {
      throw this._pipeFailure
    }
    return this._stack.connectTcp({ host, port })
  }

  async close(): Promise<void> {
    const bridge = this._bridge
    const device = this._device
    const controlIface = this._controlIface
    const dataIface = this._dataIface
    const tapWriter = this._tapWriter
    const stack = this._stack
    const tap = this._tap

    // Idempotent — safe to call after Ctrl+C or repeated cleanup
    if (!device || !bridge) return

    this._readerCancelled = true

    // Restore console.error before tearing down the stack
    if (this._originalConsoleError) {
      console.error = this._originalConsoleError
      this._originalConsoleError = null
    }

    try {
      tapWriter?.close()
    } catch {
      // Already closed
    }

    if (stack && tap) {
      try {
        await stack.removeInterface(tap)
      } catch {
        // Stack may already be torn down
      }
    }

    await bridge.close()

    if (controlIface && dataIface) {
      this._releaseAndClose(controlIface, dataIface, device)
    }

    this._device = null
    this._controlIface = null
    this._dataIface = null
    this._bridge = null
    this._tap = null
    this._stack = null
    this._tapWriter = null
  }

  // ── Private ─────────────────────────────────────────────────────────────

  /**
   * Pipe tap.readable → bridge.sendFrame in the background.
   *
   * Resolves when the transport is closed. Rejects only if the pipe breaks
   * while the transport is still open -- that is a real fault the caller
   * must record, not a teardown artefact.
   */
  private async _pipeReadableToBridge(
    readable: ReadableStream<Uint8Array>,
    bridge: EcmBridge,
  ): Promise<void> {
    const reader = readable.getReader()
    try {
      while (!this._readerCancelled) {
        const { done, value } = await reader.read()
        if (done) break
        await bridge.sendFrame(value)
      }
    } catch (err: unknown) {
      // Errors during close() are expected: the stack tears the tap down under us.
      if (!this._readerCancelled) throw err
    } finally {
      reader.releaseLock()
    }
  }

  /** Best-effort release interfaces and close device */
  private _releaseAndClose(controlIface: Interface, dataIface: Interface, device: Device): void {
    try {
      controlIface.release(() => {})
    } catch {
      /* ignore */
    }
    try {
      dataIface.release(() => {})
    } catch {
      /* ignore */
    }
    try {
      device.close()
    } catch {
      /* ignore */
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Promisified setAltSetting */
function setAltSetting(iface: Interface, alt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    iface.setAltSetting(alt, (err) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

/** Parse "aa:bb:cc:dd:ee:ff" into a 6-byte Uint8Array for fast comparison */
function parseMacBytes(mac: string): Uint8Array {
  const parts = mac.split(':')
  return new Uint8Array([
    parseInt(parts[0] ?? '0', 16),
    parseInt(parts[1] ?? '0', 16),
    parseInt(parts[2] ?? '0', 16),
    parseInt(parts[3] ?? '0', 16),
    parseInt(parts[4] ?? '0', 16),
    parseInt(parts[5] ?? '0', 16),
  ])
}

/**
 * Check if an Ethernet frame is addressed to our MAC or is broadcast.
 * Drops multicast, IPv6 neighbor discovery, IGMP, etc.
 */
function isFrameForUs(frame: Uint8Array, ourMac: Uint8Array): boolean {
  if (frame.length < 14) return false

  // Destination MAC is the first 6 bytes of the Ethernet frame
  const [d0, d1, d2, d3, d4, d5] = frame
  if (d0 === undefined) return false

  // Broadcast: ff:ff:ff:ff:ff:ff
  if (d0 === 0xff && d1 === 0xff && d2 === 0xff && d3 === 0xff && d4 === 0xff && d5 === 0xff) {
    return true
  }

  // Unicast to our MAC
  return (
    d0 === ourMac[0] &&
    d1 === ourMac[1] &&
    d2 === ourMac[2] &&
    d3 === ourMac[3] &&
    d4 === ourMac[4] &&
    d5 === ourMac[5]
  )
}
