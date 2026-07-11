/**
 * Bridge between USB bulk endpoints and RNDIS protocol.
 *
 * Handles the RNDIS initialization handshake (control transfers) and
 * bidirectional framing/deframing of Ethernet frames over bulk endpoints.
 */
import type { Device, InEndpoint, OutEndpoint } from 'usb'

import { TransportError } from '../../errors.js'
import {
  buildHaltMsg,
  buildInitializeMsg,
  buildPacketMsg,
  buildQueryMacMsg,
  buildSetPacketFilterMsg,
  isSuccess,
  parsePacketMsg,
  parseResponse,
} from './protocol.js'

// USB CDC Encapsulated Command request types
const SEND_ENCAPSULATED_COMMAND = 0x00
const GET_ENCAPSULATED_RESPONSE = 0x01
const BMREQUEST_TYPE_CLASS_INTERFACE_OUT = 0x21
const BMREQUEST_TYPE_CLASS_INTERFACE_IN = 0xa1

const ENCAPSULATED_RESPONSE_SIZE = 1024
const POLL_TRANSFERS = 3
const POLL_SIZE = 16384 // 16 KB, matches RNDIS default max transfer

type FrameHandler = (ethFrame: Uint8Array) => void
type DebugLogger = (direction: 'rx' | 'tx' | 'info', message: string) => void

export class RndisBridge {
  private readonly device: Device
  private readonly controlInterfaceNumber: number
  private readonly inEndpoint: InEndpoint
  private readonly outEndpoint: OutEndpoint
  private _frameHandler: FrameHandler | null = null
  private _requestId = 0
  private _initialized = false
  private _debug: DebugLogger | null = null

  constructor(
    device: Device,
    controlInterfaceNumber: number,
    inEndpoint: InEndpoint,
    outEndpoint: OutEndpoint,
  ) {
    this.device = device
    this.controlInterfaceNumber = controlInterfaceNumber
    this.inEndpoint = inEndpoint
    this.outEndpoint = outEndpoint
  }

  /** Enable debug logging */
  set onDebug(handler: DebugLogger | null) {
    this._debug = handler
  }

  /**
   * Initialize the RNDIS device: send INITIALIZE, set packet filter,
   * and query the device's MAC address.
   */
  async init(): Promise<string> {
    // Drain any stale encapsulated responses from previous sessions.
    // The device may cache responses that weren't read before the interface
    // was released. Without draining, the response sequence gets cross-wired:
    // we send INIT but get a stale SET_CMPLT, etc.
    await this._drainStaleResponses()

    // Step 1: RNDIS INITIALIZE
    const initMsg = buildInitializeMsg(this._nextRequestId())
    await this._sendEncapsulated(initMsg)
    const initResp = await this._getEncapsulated()
    const initParsed = parseResponse(initResp)

    if (initParsed.type !== 'initialize_cmplt' || !isSuccess(initParsed.status)) {
      throw new TransportError(
        `RNDIS initialization failed (type=${initParsed.type}, status=${
          initParsed.type !== 'unknown' ? initParsed.status : 'N/A'
        })`,
      )
    }

    // Step 2: SET packet filter (enable directed + multicast + broadcast)
    const setMsg = buildSetPacketFilterMsg(this._nextRequestId())
    await this._sendEncapsulated(setMsg)
    const setResp = await this._getEncapsulated()
    const setParsed = parseResponse(setResp)

    if (setParsed.type !== 'set_cmplt' || !isSuccess(setParsed.status)) {
      throw new TransportError(
        `RNDIS set packet filter failed (type=${setParsed.type}, status=${
          setParsed.type !== 'unknown' ? setParsed.status : 'N/A'
        })`,
      )
    }

    // Step 3: QUERY permanent MAC address
    const queryMsg = buildQueryMacMsg(this._nextRequestId())
    await this._sendEncapsulated(queryMsg)
    const queryResp = await this._getEncapsulated()
    const queryParsed = parseResponse(queryResp)

    if (
      queryParsed.type !== 'query_cmplt' ||
      !isSuccess(queryParsed.status) ||
      queryParsed.data.length < 6
    ) {
      throw new TransportError(
        `RNDIS MAC query failed: ${queryParsed.type}, status=${queryParsed.type === 'query_cmplt' ? queryParsed.status : 'N/A'}`,
      )
    }

    const mac = Array.from(queryParsed.data.slice(0, 6))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(':')

    this._initialized = true
    return mac
  }

  /** Start receiving Ethernet frames from the USB bulk IN endpoint */
  startReceiving(): void {
    if (!this._initialized) throw new TransportError('Bridge not initialized')

    this.inEndpoint.on('data', (chunk: Buffer) => {
      this._debug?.('rx', `bulk IN ${chunk.length}B`)
      const ethFrame = parsePacketMsg(chunk)
      if (ethFrame !== undefined) {
        this._debug?.('rx', `eth ${ethFrame.length}B`)
        this._frameHandler?.(ethFrame)
      }
    })

    this.inEndpoint.on('error', (err) => {
      this._debug?.('rx', `error: ${err.message}`)
    })

    this.inEndpoint.startPoll(POLL_TRANSFERS, POLL_SIZE)
  }

  /** Send an Ethernet frame to the USB device */
  async sendFrame(ethFrame: Uint8Array): Promise<void> {
    if (!this._initialized) throw new TransportError('Bridge not initialized')
    this._debug?.('tx', `eth ${ethFrame.length}B`)

    const rndisPacket = buildPacketMsg(ethFrame)
    const buffer = Buffer.from(rndisPacket)

    await new Promise<void>((resolve, reject) => {
      this.outEndpoint.transfer(buffer, (err) => {
        if (err) {
          reject(new TransportError('RNDIS bulk write failed', { cause: err }))
          return
        }
        resolve()
      })
    })
  }

  /** Register handler for incoming Ethernet frames */
  onFrame(handler: FrameHandler): void {
    this._frameHandler = handler
  }

  /** Stop polling and send RNDIS HALT */
  async close(): Promise<void> {
    // Stop bulk IN polling
    await new Promise<void>((resolve) => {
      this.inEndpoint.stopPoll(() => resolve())
    })
    this.inEndpoint.removeAllListeners()

    // Send HALT (best-effort, device may already be disconnected)
    try {
      const haltMsg = buildHaltMsg(this._nextRequestId())
      await this._sendEncapsulated(haltMsg)
    } catch {
      // Ignore — device may be gone
    }

    this._initialized = false
  }

  // ── USB control transfers ───────────────────────────────────────────────

  /**
   * Read and discard any stale encapsulated responses left in the device's
   * buffer from previous sessions. Reads up to 5 times, stopping on the
   * first error (which means the buffer is empty).
   */
  private async _drainStaleResponses(): Promise<void> {
    const MAX_DRAIN = 5
    for (let i = 0; i < MAX_DRAIN; i++) {
      try {
        const resp = await this._getEncapsulated()
        const parsed = parseResponse(resp)
        this._debug?.('info', `drained stale response: ${parsed.type}`)
      } catch {
        // No more stale responses -- buffer is clean
        return
      }
    }
  }

  private _nextRequestId(): number {
    this._requestId += 1
    return this._requestId
  }

  /** SEND_ENCAPSULATED_COMMAND (host → device control message) */
  private async _sendEncapsulated(data: Uint8Array): Promise<void> {
    const buffer = Buffer.from(data)

    await new Promise<void>((resolve, reject) => {
      this.device.controlTransfer(
        BMREQUEST_TYPE_CLASS_INTERFACE_OUT,
        SEND_ENCAPSULATED_COMMAND,
        0, // wValue
        this.controlInterfaceNumber, // wIndex
        buffer,
        (err) => {
          if (err) {
            reject(new TransportError('RNDIS SEND_ENCAPSULATED_COMMAND failed', { cause: err }))
            return
          }
          resolve()
        },
      )
    })
  }

  /** GET_ENCAPSULATED_RESPONSE (device → host control message) */
  private async _getEncapsulated(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this.device.controlTransfer(
        BMREQUEST_TYPE_CLASS_INTERFACE_IN,
        GET_ENCAPSULATED_RESPONSE,
        0, // wValue
        this.controlInterfaceNumber, // wIndex
        ENCAPSULATED_RESPONSE_SIZE,
        (err, data) => {
          if (err) {
            reject(new TransportError('RNDIS GET_ENCAPSULATED_RESPONSE failed', { cause: err }))
            return
          }
          if (data === undefined || typeof data === 'number') {
            reject(new TransportError('RNDIS GET_ENCAPSULATED_RESPONSE returned no data'))
            return
          }
          resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        },
      )
    })
  }
}
