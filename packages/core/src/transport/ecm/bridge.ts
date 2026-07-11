/**
 * Bridge between USB bulk endpoints and raw Ethernet frames (CDC-ECM).
 *
 * CDC-ECM is simpler than RNDIS: no initialization handshake, no frame
 * wrapping. Ethernet frames go directly on the bulk endpoints.
 *
 * MAC address is read from the CDC Ethernet Networking Functional Descriptor
 * embedded in the control interface's class-specific descriptors.
 */
import type { Device, InEndpoint, OutEndpoint } from 'usb'

import { TransportError } from '../../errors.js'

const POLL_TRANSFERS = 3
const POLL_SIZE = 2048 // ECM max segment is typically 1514

// CDC class-specific descriptor constants
const CS_INTERFACE = 0x24
const CDC_ETHERNET_NETWORKING = 0x0f

type FrameHandler = (ethFrame: Uint8Array) => void

export class EcmBridge {
  private readonly device: Device
  private readonly controlInterfaceNumber: number
  private readonly inEndpoint: InEndpoint
  private readonly outEndpoint: OutEndpoint
  private _frameHandler: FrameHandler | null = null
  private _receiving = false

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

  /**
   * Read the device MAC address from the CDC Ethernet Functional Descriptor.
   *
   * The descriptor lives in the control interface's extra bytes (CS_INTERFACE,
   * subtype 0x0F). The iMACAddress field is a string descriptor index pointing
   * to a 12-char hex string like "b699db2854fa".
   */
  async readMac(): Promise<string> {
    const iface = this.device.interface(this.controlInterfaceNumber)
    const extra = iface?.descriptor?.extra

    if (!extra || extra.length === 0) {
      return generateFallbackMac()
    }

    const macIndex = findMacDescriptorIndex(extra)
    if (macIndex === undefined) {
      return generateFallbackMac()
    }

    const macHex = await readStringDescriptor(this.device, macIndex)
    if (macHex === undefined || macHex.length !== 12) {
      return generateFallbackMac()
    }

    return formatMac(macHex)
  }

  /** Start receiving raw Ethernet frames from the USB bulk IN endpoint */
  startReceiving(): void {
    if (this._receiving) return

    this.inEndpoint.on('data', (chunk: Buffer) => {
      // ECM: raw Ethernet frames, no wrapping to strip
      if (chunk.length > 0) {
        this._frameHandler?.(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      }
    })

    this.inEndpoint.on('error', () => {
      // USB transfer errors during normal operation (device busy, etc.)
    })

    this.inEndpoint.startPoll(POLL_TRANSFERS, POLL_SIZE)
    this._receiving = true
  }

  /** Send a raw Ethernet frame to the USB device */
  async sendFrame(ethFrame: Uint8Array): Promise<void> {
    const buffer = Buffer.from(ethFrame)

    await new Promise<void>((resolve, reject) => {
      this.outEndpoint.transfer(buffer, (err) => {
        if (err) {
          reject(new TransportError('ECM bulk write failed', { cause: err }))
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

  /** Stop polling. No shutdown handshake needed for ECM. */
  async close(): Promise<void> {
    if (!this._receiving) return

    await new Promise<void>((resolve) => {
      this.inEndpoint.stopPoll(() => resolve())
    })
    this.inEndpoint.removeAllListeners()
    this._receiving = false
  }
}

// ── CDC descriptor parsing ─────────────────────────────────────────────────

/**
 * Find the iMACAddress string descriptor index from CDC functional descriptors.
 *
 * Walks the descriptor chain in the interface's extra bytes looking for
 * the Ethernet Networking Functional Descriptor (CS_INTERFACE, subtype 0x0F).
 */
function findMacDescriptorIndex(extra: Buffer): number | undefined {
  let offset = 0
  while (offset + 2 < extra.length) {
    const len = extra[offset]
    if (len === undefined || len < 3) break

    const type = extra[offset + 1]
    const subtype = extra[offset + 2]

    // CDC Ethernet Networking Functional Descriptor: 13 bytes
    // byte 3 = iMACAddress (string descriptor index)
    if (type === CS_INTERFACE && subtype === CDC_ETHERNET_NETWORKING && len >= 4) {
      return extra[offset + 3]
    }

    offset += len
  }
  return undefined
}

/** Read a USB string descriptor by index */
function readStringDescriptor(device: Device, index: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    device.getStringDescriptor(index, (err, str) => {
      if (err || str === undefined) {
        resolve(undefined)
        return
      }
      resolve(str)
    })
  })
}

/** Format "b699db2854fa" -> "b6:99:db:28:54:fa" */
function formatMac(hex: string): string {
  const parts: string[] = []
  for (let i = 0; i < 12; i += 2) {
    parts.push(hex.slice(i, i + 2))
  }
  return parts.join(':')
}

/** Generate a locally-administered MAC when descriptor parsing fails */
function generateFallbackMac(): string {
  return '02:00:00:ec:00:01'
}
