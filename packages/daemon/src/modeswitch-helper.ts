/**
 * Standalone USB mode switch helper for macOS.
 *
 * Runs as root (via sudoers) in the user's Mach bootstrap context (via LaunchAgent).
 * This combination is required on macOS because:
 * - Root: needed for libusb USB device access
 * - User bootstrap: IOKit grants USBInterfaceOpen only in user context
 *
 * Called by the modeswitch LaunchAgent, NOT by the daemon directly.
 *
 * Implements full SCSI StandardEject sequence (matches usb_modeswitch):
 * 1. INQUIRY — identify device, establish SCSI session
 * 2. TEST UNIT READY — verify device is responsive
 * 3. PREVENT ALLOW MEDIUM REMOVAL — unlock media
 * 4. START STOP UNIT with LoEj=1 — eject (triggers USB re-enumeration)
 *
 * Usage: node modeswitch-helper.js <vid> <pid> <usb_module_path> [cbw_hex]
 *
 * If cbw_hex is provided, sends that exact CBW instead of StandardEject.
 *
 * Outcome is reported via exit code (0 = success) and a message on stderr,
 * which the spawning parent (core's spawnModeswitchHelper) captures. It must
 * NOT write to a predictable /tmp path: this process runs as root, and a
 * world-writable directory invites a symlink attack (attacker pre-creates the
 * path as a symlink to a root-owned file → root truncates the target).
 */

const SCSI_CBW_SIGNATURE = 0x43425355
const SCSI_CSW_SIGNATURE = 0x53425355
const CBW_LENGTH = 31
const CSW_LENGTH = 13
const INQUIRY_DATA_LENGTH = 36
const TRANSFER_TIMEOUT_MS = 5000

function fatal(code: number, message: string): never {
  process.stderr.write(`[modeswitch-helper] ${message}\n`)
  process.exit(code)
}

function succeed(message: string): never {
  process.stderr.write(`[modeswitch-helper] ${message}\n`)
  process.exit(0)
}

// ── Arg validation ──────────────────────────────────────────────────────────

const vid = Number.parseInt(process.argv[2] ?? '', 10)
const pid = Number.parseInt(process.argv[3] ?? '', 10)
const usbModulePath = process.argv[4]
const rawCbwHex = process.argv[5] // optional: hex-encoded raw CBW to send instead of StandardEject

if (Number.isNaN(vid) || Number.isNaN(pid)) {
  fatal(10, `Invalid VID/PID: ${process.argv[2]}/${process.argv[3]}`)
}
if (typeof usbModulePath !== 'string' || usbModulePath.length === 0) {
  fatal(12, 'Missing usb module path argument')
}

// Safety timeout: kill if stuck
setTimeout(() => fatal(99, 'Timeout: mode switch took longer than 15 seconds'), 15_000)

// ── SCSI CBW builder ────────────────────────────────────────────────────────

let nextTag = 1

function buildCbw(cdb: number[], dataLength: number, directionIn: boolean): Buffer {
  const buf = Buffer.alloc(CBW_LENGTH)
  buf.writeUInt32LE(SCSI_CBW_SIGNATURE, 0)
  buf.writeUInt32LE(nextTag++, 4)
  buf.writeUInt32LE(dataLength, 8)
  buf.writeUInt8(directionIn ? 0x80 : 0x00, 12)
  buf.writeUInt8(0, 13) // LUN
  buf.writeUInt8(cdb.length, 14)
  for (let i = 0; i < cdb.length && i < 16; i++) {
    const byte = cdb[i]
    if (byte !== undefined) buf.writeUInt8(byte, 15 + i)
  }
  return buf
}

// ── Bulk transfer helpers ───────────────────────────────────────────────────

interface TypedOutEndpoint {
  timeout: number
  transfer: (data: Buffer, callback: (err: Error | undefined) => void) => void
}

interface TypedInEndpoint {
  timeout: number
  transfer: (length: number, callback: (err: Error | undefined, data?: Buffer) => void) => void
}

function bulkOut(ep: TypedOutEndpoint, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const saved = ep.timeout
    ep.timeout = TRANSFER_TIMEOUT_MS
    ep.transfer(data, (err) => {
      ep.timeout = saved
      if (err) reject(err)
      else resolve()
    })
  })
}

function bulkIn(ep: TypedInEndpoint, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const saved = ep.timeout
    ep.timeout = TRANSFER_TIMEOUT_MS
    ep.transfer(length, (err, data) => {
      ep.timeout = saved
      if (err) reject(err)
      else resolve(data ?? Buffer.alloc(0))
    })
  })
}

function isDeviceGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('NO_DEVICE') ||
    msg.includes('TRANSFER_ERROR') ||
    msg.includes('PIPE') ||
    msg.includes('STALL')
  )
}

// ── Mode switch ─────────────────────────────────────────────────────────────

try {
  // Dynamic require: path passed as arg, avoids bundling issues
  const { findByIds, usb, OutEndpoint, InEndpoint } = require(usbModulePath)

  const device = findByIds(vid, pid)
  if (!device) {
    fatal(1, `Device not found: VID=0x${vid.toString(16)} PID=0x${pid.toString(16)}`)
  }

  device.open()
  try {
    device.setAutoDetachKernelDriver(true)
  } catch {
    // Not supported on macOS
  }

  const MASS_STORAGE_CLASS = usb.LIBUSB_CLASS_MASS_STORAGE
  const iface = device.interfaces.find(
    (i: { descriptor: { bInterfaceClass: number } }) =>
      i.descriptor.bInterfaceClass === MASS_STORAGE_CLASS,
  )
  if (!iface) {
    device.close()
    fatal(2, 'No mass storage interface found')
  }

  try {
    iface.detachKernelDriver()
  } catch {
    // May not be active
  }

  iface.claim()

  const BULK_TYPE = usb.LIBUSB_TRANSFER_TYPE_BULK
  const outEp = iface.endpoints.find(
    (ep: { direction: string; transferType: number }) =>
      ep.direction === 'out' && ep.transferType === BULK_TYPE,
  )
  const inEp = iface.endpoints.find(
    (ep: { direction: string; transferType: number }) =>
      ep.direction === 'in' && ep.transferType === BULK_TYPE,
  )

  if (!outEp || !(outEp instanceof OutEndpoint)) {
    try {
      iface.release()
    } catch {}
    device.close()
    fatal(3, 'No bulk OUT endpoint found')
  }
  if (!inEp || !(inEp instanceof InEndpoint)) {
    try {
      iface.release()
    } catch {}
    device.close()
    fatal(3, 'No bulk IN endpoint found')
  }

  // ── Full StandardEject SCSI sequence ────────────────────────────────────

  const cleanup = () => {
    try {
      iface.release(() => {
        try {
          device.close()
        } catch {}
      })
    } catch {}
  }

  const sendCbw = async (cbw: Buffer, label: string): Promise<boolean> => {
    try {
      await bulkOut(outEp, cbw)
      return true
    } catch (err: unknown) {
      if (isDeviceGone(err)) return true // device disconnected = eject worked
      cleanup()
      fatal(4, `SCSI ${label} transfer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const readData = async (length: number): Promise<Buffer | undefined> => {
    try {
      return await bulkIn(inEp, length)
    } catch (err: unknown) {
      if (isDeviceGone(err)) return undefined
      return undefined // non-fatal: continue sequence
    }
  }

  const readCsw = async (): Promise<void> => {
    try {
      const data = await bulkIn(inEp, CSW_LENGTH)
      if (data.length >= CSW_LENGTH) {
        const sig = data.readUInt32LE(0)
        const status = data.readUInt8(12)
        if (sig === SCSI_CSW_SIGNATURE && status !== 0) {
          // CSW status != PASSED is non-fatal for mode switching
        }
      }
    } catch (err: unknown) {
      if (isDeviceGone(err)) return
      // CSW read failure is non-fatal
    }
  }

  // Run the sequence as async IIFE
  ;(async () => {
    try {
      // If raw CBW hex provided, send it directly (vendor-specific SCSI command)
      if (typeof rawCbwHex === 'string' && rawCbwHex.length > 0) {
        const rawCbw = Buffer.from(rawCbwHex, 'hex')
        await sendCbw(rawCbw, 'vendor CBW')
        cleanup()
        succeed('Vendor CBW sent (device should re-enumerate)')
      }

      // StandardEject sequence: INQUIRY → TUR → ALLOW → EJECT

      // 1. INQUIRY
      const inquirySent = await sendCbw(
        buildCbw([0x12, 0x00, 0x00, 0x00, 0x24, 0x00], INQUIRY_DATA_LENGTH, true),
        'INQUIRY',
      )
      if (inquirySent) {
        await readData(INQUIRY_DATA_LENGTH)
        await readCsw()
      }

      // 2. TEST UNIT READY
      const turSent = await sendCbw(
        buildCbw([0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 0, false),
        'TEST UNIT READY',
      )
      if (turSent) {
        await readCsw()
      }

      // 3. PREVENT ALLOW MEDIUM REMOVAL (allow)
      const allowSent = await sendCbw(
        buildCbw([0x1e, 0x00, 0x00, 0x00, 0x00, 0x00], 0, false),
        'ALLOW MEDIUM REMOVAL',
      )
      if (allowSent) {
        await readCsw()
      }

      // 4. START STOP UNIT with LoEj=1, Start=0 (eject)
      await sendCbw(
        buildCbw([0x1b, 0x00, 0x00, 0x00, 0x02, 0x00], 0, false),
        'START STOP UNIT (eject)',
      )

      cleanup()
      succeed('StandardEject sequence completed (device should re-enumerate)')
    } catch (err: unknown) {
      cleanup()
      const message = err instanceof Error ? err.message : String(err)
      fatal(6, `StandardEject sequence failed: ${message}`)
    }
  })().catch((err: unknown) => {
    // Safety net: inner try/catch should handle everything,
    // but .catch() prevents unhandled rejection warnings
    cleanup()
    const message = err instanceof Error ? err.message : String(err)
    fatal(7, `Unhandled rejection: ${message}`)
  })
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  fatal(5, `Unexpected error: ${message}`)
}
