/**
 * RNDIS USB Transport — userspace networking for USB devices that
 * only expose RNDIS (USB Ethernet) with no OS kernel driver.
 *
 * Uses tcpip (lwIP WASM) as the TCP/IP stack on top of raw RNDIS
 * bulk transfers. No root required, fully cross-platform.
 *
 * Architecture:
 *   USB bulk endpoints
 *       ↕ RNDIS framing (bridge.ts)
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
import { RndisBridge } from './bridge.js'

export type { TcpConnection } from 'tcpip'

export interface RndisTransportOptions {
  /** USB vendor ID */
  readonly vendorId: number
  /** USB product ID */
  readonly productId: number
  /** RNDIS control interface number (usually 0) */
  readonly controlInterface?: number | undefined
  /** RNDIS data interface number (usually 1) */
  readonly dataInterface?: number | undefined
  /** IP address for the local (host) side, CIDR notation */
  readonly localIp?: string | undefined
  /** Gateway IP (the device's IP address) */
  readonly gatewayIp?: string | undefined
}

const DEFAULT_CONTROL_INTERFACE = 0
const DEFAULT_DATA_INTERFACE = 1
const DEFAULT_LOCAL_IP = '192.168.100.2/24'
const DEFAULT_GATEWAY_IP = '192.168.100.1'

/**
 * Provides TCP connectivity to a USB device via RNDIS.
 *
 * After open(), use connectTcp() to establish TCP connections to
 * the device's IP address (typically 192.168.100.1).
 *
 * @example
 * ```ts
 * const transport = new RndisTransport({
 *   vendorId: 0x05c6,
 *   productId: 0xf00e,
 * })
 * await transport.open()
 * const conn = await transport.connectTcp('192.168.100.1', 80)
 * // use conn.readable / conn.writable for HTTP
 * await transport.close()
 * ```
 */
export class RndisTransport {
  private readonly _options: RndisTransportOptions

  private _device: Device | null = null
  private _controlIface: Interface | null = null
  private _dataIface: Interface | null = null
  private _bridge: RndisBridge | null = null
  private _tap: TapInterface | null = null
  private _stack: Awaited<ReturnType<typeof createStack>> | null = null
  private _tapWriter: WritableStreamDefaultWriter<Uint8Array> | null = null
  private _readerCancelled = false
  /**
   * Set when the stack-to-device pipe died while the transport was still open
   * (e.g. a bulk write failed after the device dropped off the bus). The tunnel
   * is half-dead from then on: frames still arrive but nothing can be sent, so
   * every later request would hang until its read timeout. Recording the
   * failure lets connectTcp() fail immediately with the real cause instead.
   */
  private _pipeFailure: TransportError | null = null

  constructor(options: RndisTransportOptions) {
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

  async open(): Promise<void> {
    if (this._device !== null) {
      throw new TransportError('RNDIS transport is already open')
    }

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

    // ── Claim interfaces ────────────────────────────────────────────────

    const controlIface = device.interface(controlIfNum)
    const dataIface = device.interface(dataIfNum)

    if (!controlIface || !dataIface) {
      device.close()
      throw new TransportError(
        `RNDIS interfaces ${controlIfNum}/${dataIfNum} not found on ${label}`,
      )
    }

    for (const iface of [controlIface, dataIface]) {
      try {
        if (iface.isKernelDriverActive()) iface.detachKernelDriver()
      } catch {
        // Not supported on all platforms
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

    // ── Initialize RNDIS ────────────────────────────────────────────────

    const bridge = new RndisBridge(device, controlIfNum, inEp, outEp)
    let deviceMac: string
    try {
      deviceMac = await bridge.init()
    } catch (error: unknown) {
      this._releaseAndClose(controlIface, dataIface, device)
      throw error
    }

    // ── Create TCP/IP stack ─────────────────────────────────────────────

    const localIp = this._options.localIp ?? DEFAULT_LOCAL_IP
    const stack = await createStack()

    // Create a locally-administered MAC for our side
    const localMac = deriveLocalMac(deviceMac)

    const tap = await stack.createTapInterface({
      mac: localMac,
      ip: parseIpv4Cidr(localIp),
    })

    // ── Wire bridge ↔ tcpip.js ──────────────────────────────────────────

    // Device → tcpip: USB bulk IN frames go into the stack
    const tapWriter = tap.writable.getWriter()
    bridge.onFrame((ethFrame) => {
      tapWriter.write(ethFrame).catch(() => {
        // Stack may be closing
      })
    })

    // tcpip → Device: stack's outgoing frames go to USB bulk OUT
    this._readerCancelled = false
    this._pipeFailure = null
    this._pipeReadableToBridge(tap.readable, bridge).catch((err: unknown) => {
      this._pipeFailure = new TransportError(
        'RNDIS tunnel failed: device stopped accepting frames',
        {
          cause: err,
        },
      )
    })

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

  /** Establish a TCP connection through the RNDIS tunnel */
  async connectTcp(host: string, port: number): Promise<TcpConnection> {
    if (!this._stack) {
      throw new TransportError('RNDIS transport is not open')
    }
    if (this._pipeFailure !== null) {
      throw this._pipeFailure
    }
    return this._stack.connectTcp({ host, port })
  }

  /** Gateway IP address (the device) */
  get gatewayIp(): string {
    return this._options.gatewayIp ?? DEFAULT_GATEWAY_IP
  }

  async close(): Promise<void> {
    const bridge = this._bridge
    const device = this._device
    const controlIface = this._controlIface
    const dataIface = this._dataIface
    const tapWriter = this._tapWriter
    const stack = this._stack
    const tap = this._tap

    if (!device || !bridge) {
      throw new TransportError('RNDIS transport is not open')
    }

    this._readerCancelled = true

    // Close tcpip writer
    try {
      tapWriter?.close()
    } catch {
      // Already closed
    }

    // Remove tap interface from stack
    if (stack && tap) {
      try {
        await stack.removeInterface(tap)
      } catch {
        // Stack may already be torn down
      }
    }

    // Close RNDIS bridge (stops poll, sends HALT)
    await bridge.close()

    // Release USB interfaces
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
    bridge: RndisBridge,
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
