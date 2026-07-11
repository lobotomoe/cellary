/**
 * SCSI Standard Eject over USB Mass Storage Bulk-Only Transport.
 *
 * Implements the full usb_modeswitch StandardEject sequence:
 * 1. SCSI INQUIRY — identify the device, establish SCSI session
 * 2. SCSI TEST UNIT READY — verify device is ready
 * 3. SCSI PREVENT ALLOW MEDIUM REMOVAL — unlock media
 * 4. SCSI START STOP UNIT with LoEj=1 — eject (triggers USB re-enumeration)
 *
 * The warm-up commands (1-3) are critical: many devices ignore a naked
 * START STOP UNIT without prior SCSI handshake. This matches what
 * usb_modeswitch does for `StandardEject=1`.
 *
 * Between each command, we read the SCSI CSW (Command Status Wrapper)
 * to confirm the device processed the command. For INQUIRY, we also
 * read the response data.
 */

import type { Device, Interface } from 'usb'
import { InEndpoint, OutEndpoint, usb } from 'usb'

import { DiscoveryError } from '../errors.js'

// ── Constants ────────────────────────────────────────────────────────────────

const SCSI_CBW_SIGNATURE = 0x43425355 // "USBC"
const SCSI_CBW_LENGTH = 31
const SCSI_CSW_LENGTH = 13
const SCSI_CSW_SIGNATURE = 0x53425355 // "USBS"

const SCSI_INQUIRY_RESPONSE_LENGTH = 36
const BULK_TRANSFER_TIMEOUT_MS = 5000

/** CSW status values per USB Mass Storage Bulk-Only Transport spec */
const CSW_STATUS_PASSED = 0
const CSW_STATUS_FAILED = 1

// ── Types ────────────────────────────────────────────────────────────────────

interface BulkEndpoints {
  readonly out: OutEndpoint
  readonly in: InEndpoint
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Execute the full StandardEject SCSI sequence on a claimed mass storage interface.
 *
 * The device is expected to be open and the interface claimed before calling.
 * After the eject command, the device disconnects (USB re-enumeration).
 * Transfer errors on the final command are expected and not thrown.
 */
export async function executeStandardEject(device: Device): Promise<void> {
  const iface = findMassStorageInterface(device)

  detachKernelDriverSafe(iface)
  iface.claim()

  try {
    const endpoints = findBulkEndpoints(iface)
    await runEjectSequence(endpoints)
  } finally {
    releaseAndCloseSafe(iface, device)
  }
}

// ── SCSI sequence ────────────────────────────────────────────────────────────

async function runEjectSequence(ep: BulkEndpoints): Promise<void> {
  let tag = 1

  // 1. INQUIRY: identify device, establish SCSI session
  const inquiryCbw = buildCbw(
    tag++,
    [0x12, 0x00, 0x00, 0x00, 0x24, 0x00],
    SCSI_INQUIRY_RESPONSE_LENGTH,
    true,
  )
  const inquirySent = await sendCbwSafe(ep.out, inquiryCbw, 'INQUIRY')
  if (inquirySent) {
    // Read inquiry data (36 bytes) — we don't parse it, just consume
    await readDataSafe(ep.in, SCSI_INQUIRY_RESPONSE_LENGTH, 'INQUIRY data')
    await readCswSafe(ep.in)
  }

  // 2. TEST UNIT READY: verify device is responsive
  const turCbw = buildCbw(tag++, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0, false)
  const turSent = await sendCbwSafe(ep.out, turCbw, 'TEST UNIT READY')
  if (turSent) {
    await readCswSafe(ep.in)
  }

  // 3. PREVENT ALLOW MEDIUM REMOVAL: unlock media for ejection
  const allowCbw = buildCbw(tag++, [0x1e, 0x00, 0x00, 0x00, 0x00, 0x00], 0, false)
  const allowSent = await sendCbwSafe(ep.out, allowCbw, 'ALLOW MEDIUM REMOVAL')
  if (allowSent) {
    await readCswSafe(ep.in)
  }

  // 4. START STOP UNIT with LoEj=1, Start=0: eject media (triggers re-enumeration)
  // Device disconnects after this — transfer error is expected.
  const ejectCbw = buildCbw(tag++, [0x1b, 0x00, 0x00, 0x00, 0x02, 0x00], 0, false)
  await sendCbwSafe(ep.out, ejectCbw, 'START STOP UNIT (eject)')
  // No CSW read — device disconnects
}

// ── CBW/CSW builders ─────────────────────────────────────────────────────────

function buildCbw(
  tag: number,
  cdb: readonly number[],
  dataLength: number,
  directionIn: boolean,
): Buffer {
  const buf = Buffer.alloc(SCSI_CBW_LENGTH)
  buf.writeUInt32LE(SCSI_CBW_SIGNATURE, 0)
  buf.writeUInt32LE(tag, 4)
  buf.writeUInt32LE(dataLength, 8)
  buf.writeUInt8(directionIn ? 0x80 : 0x00, 12)
  buf.writeUInt8(0, 13) // LUN
  buf.writeUInt8(cdb.length, 14)

  for (let i = 0; i < cdb.length && i < 16; i++) {
    const byte = cdb[i]
    if (byte !== undefined) {
      buf.writeUInt8(byte, 15 + i)
    }
  }
  return buf
}

function parseCsw(data: Buffer): { tag: number; status: number } | undefined {
  if (data.length < SCSI_CSW_LENGTH) return undefined
  const signature = data.readUInt32LE(0)
  if (signature !== SCSI_CSW_SIGNATURE) return undefined
  return {
    tag: data.readUInt32LE(4),
    status: data.readUInt8(12),
  }
}

// ── Bulk transfer wrappers ───────────────────────────────────────────────────

function bulkOut(ep: OutEndpoint, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const saved = ep.timeout
    ep.timeout = BULK_TRANSFER_TIMEOUT_MS
    ep.transfer(data, (err) => {
      ep.timeout = saved
      if (err) reject(err)
      else resolve()
    })
  })
}

function bulkIn(ep: InEndpoint, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const saved = ep.timeout
    ep.timeout = BULK_TRANSFER_TIMEOUT_MS
    ep.transfer(length, (err, data) => {
      ep.timeout = saved
      if (err) reject(err)
      else resolve(data ?? Buffer.alloc(0))
    })
  })
}

/**
 * Send a CBW, treating device disconnect as success (expected during eject).
 * Returns true if the command was sent (or device disconnected during send).
 */
async function sendCbwSafe(ep: OutEndpoint, cbw: Buffer, label: string): Promise<boolean> {
  try {
    await bulkOut(ep, cbw)
    return true
  } catch (err: unknown) {
    if (isDeviceDisconnectError(err)) {
      // Device disconnected = eject worked
      return true
    }
    // CANCELLED = transfer was aborted by the host, command didn't reach device.
    // This is a real error — don't mask it.
    throw new DiscoveryError(`SCSI ${label} transfer failed`, { cause: err })
  }
}

async function readDataSafe(
  ep: InEndpoint,
  length: number,
  label: string,
): Promise<Buffer | undefined> {
  try {
    return await bulkIn(ep, length)
  } catch (err: unknown) {
    if (isDeviceDisconnectError(err)) return undefined
    throw new DiscoveryError(`SCSI ${label} read failed`, { cause: err })
  }
}

async function readCswSafe(ep: InEndpoint): Promise<boolean> {
  try {
    const data = await bulkIn(ep, SCSI_CSW_LENGTH)
    const csw = parseCsw(data)
    if (!csw) return false
    if (csw.status === CSW_STATUS_FAILED) {
      // SCSI command failed, but this is non-fatal for mode switching.
      // usb_modeswitch also ignores CSW failures during StandardEject.
      return false
    }
    return csw.status === CSW_STATUS_PASSED
  } catch (err: unknown) {
    if (isDeviceDisconnectError(err)) return true
    // CSW read failures are non-fatal — continue with next command
    return false
  }
}

// ── USB helpers ──────────────────────────────────────────────────────────────

export function findMassStorageInterface(device: Device): Interface {
  const iface = device.interfaces?.find(
    (i) => i.descriptor.bInterfaceClass === usb.LIBUSB_CLASS_MASS_STORAGE,
  )
  if (!iface) {
    throw new DiscoveryError('No mass storage interface found on device')
  }
  return iface
}

function findBulkEndpoints(iface: Interface): BulkEndpoints {
  const bulkType = usb.LIBUSB_TRANSFER_TYPE_BULK
  const outEp = iface.endpoints.find((ep) => ep.direction === 'out' && ep.transferType === bulkType)
  const inEp = iface.endpoints.find((ep) => ep.direction === 'in' && ep.transferType === bulkType)

  if (!outEp || !(outEp instanceof OutEndpoint)) {
    throw new DiscoveryError('No bulk OUT endpoint found on mass storage interface')
  }
  if (!inEp || !(inEp instanceof InEndpoint)) {
    throw new DiscoveryError('No bulk IN endpoint found on mass storage interface')
  }
  return { out: outEp, in: inEp }
}

export function detachKernelDriverSafe(iface: Interface): void {
  try {
    iface.detachKernelDriver()
  } catch {
    // NOT_FOUND, NOT_SUPPORTED, or other — safe to ignore
  }
}

function releaseAndCloseSafe(iface: Interface, device: Device): void {
  try {
    iface.release(() => {
      try {
        device.close()
      } catch {
        // Device may already be gone
      }
    })
  } catch {
    try {
      device.close()
    } catch {
      // Device may already be gone
    }
  }
}

function isDeviceDisconnectError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes('NO_DEVICE') ||
    message.includes('TRANSFER_ERROR') ||
    message.includes('PIPE') ||
    message.includes('STALL')
  )
}
