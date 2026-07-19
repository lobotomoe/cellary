/**
 * USB mode switching for cellular modems.
 *
 * Many USB modems present as a virtual CD-ROM drive when first plugged in.
 * This module sends vendor-specific commands to trigger re-enumeration
 * as a modem/serial device.
 *
 * Switch methods tried in order:
 * 1. Vendor-specific methods from the database (vendor control, SCSI CBW)
 * 2. macOS diskutil eject fallback (when OS loaded the mass storage driver)
 *
 * All macOS device lookups go through the structured ioreg parser (ioreg.ts),
 * which keeps each device's `BSD Name` scoped to its own subtree. This module
 * therefore never ejects a disk it cannot attribute to the target modem — a
 * safety property that matters because `diskutil eject` on the wrong disk is
 * data loss.
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

import type { Device, OutEndpoint } from 'usb'
import { findByIds, getDeviceList } from 'usb'

import { DiscoveryError } from '../errors.js'
import { sleep } from '../utils.js'
import {
  busLocationToLocationId,
  type IoregUsbDevice,
  readIoregUsbDevices,
  selectIoregDevice,
  wholeDiskBsdName,
} from './ioreg.js'
import type { ScsiCbwSwitch, SwitchMethod, UsbLocation, VendorControlSwitch } from './usb-types.js'

// Re-exported for callers that import switch descriptors alongside switchDevice().
export type { ScsiCbwSwitch, SwitchMethod, VendorControlSwitch }

const execFileAsync = promisify(execFile)

const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 6

// macOS disk-device timing: the driver chain (IOUSBMassStorageDriver -> SCSI ->
// IOMedia -> BSD) takes 1-5s to publish a BSD node after attach.
const DISK_WAIT_MAX_MS = 15_000
const DISK_WAIT_INTERVAL_MS = 1000
const REENUM_WAIT_MAX_MS = 20_000
const REENUM_WAIT_INTERVAL_MS = 2000
const DISKUTIL_TIMEOUT_MS = 10_000
const HELPER_TIMEOUT_MS = 20_000

/** Minimal shape needed from StorageDeviceEntry for preflight (avoids circular import). */
interface StorageDeviceEntry {
  readonly vendor: number
  readonly name: string
  readonly storageProducts: readonly number[]
}

// ── macOS preflight ──────────────────────────────────────────────────────────

/**
 * macOS-only: detect and eject storage-mode USB modems BEFORE libusb is used.
 *
 * On macOS, libusb's getDeviceList() opens IOKit user clients that interfere
 * with the mass storage driver chain (IOUSBMassStorageDriver -> SCSI -> IOMedia).
 * If libusb touches a storage-mode device, macOS fails to create the BSD disk
 * device needed for `diskutil eject`.
 *
 * This function uses `ioreg` (IOKit Registry, read-only, no USB handles) to
 * detect storage-mode devices, waits for macOS to create disk devices, and
 * ejects them via `diskutil`. Only after all storage devices have been ejected
 * (or timed out) should the caller initialize libusb.
 *
 * @param database - USB modem database entries to match against
 * @returns Array of VID/PID pairs that were successfully ejected
 */
export async function preflightDarwinModeSwitch(
  database: readonly StorageDeviceEntry[],
): Promise<Array<{ vendorId: number; productId: number }>> {
  if (process.platform !== 'darwin') return []

  const log = (msg: string) => process.stderr.write(`[modeswitch] ${msg}\n`)
  const storageLookup = buildStorageLookup(database)
  if (storageLookup.size === 0) return []

  const devices = await readIoregUsbDevices()
  const storageDevices = devices.filter((d) => storageLookup.get(d.idVendor)?.pids.has(d.idProduct))

  if (storageDevices.length === 0) return []

  log(`Preflight: found ${storageDevices.length} storage-mode device(s)`)

  const ejected: Array<{ vendorId: number; productId: number }> = []

  for (const device of storageDevices) {
    const name = storageLookup.get(device.idVendor)?.name ?? 'device'
    log(`Preflight: ${name} (${hex(device.idVendor)}:${hex(device.idProduct)}) needs mode switch`)

    // Wait for macOS to publish this exact device's disk (keyed by locationID).
    const bsdName = await waitForWholeDisk(
      device.idVendor,
      device.idProduct,
      device.locationID,
      log,
    )
    if (bsdName === undefined) {
      log(`Preflight: no disk device for ${name}, skipping`)
      continue
    }

    log(`Preflight: diskutil eject ${bsdName}`)
    const ok = await ejectDisk(bsdName)
    if (ok) {
      log(`Preflight: ejected ${name}, waiting for re-enumeration...`)
      ejected.push({ vendorId: device.idVendor, productId: device.idProduct })
      await waitForDeviceGone(device.idVendor, device.idProduct, device.locationID)
    } else {
      log(`Preflight: diskutil eject failed for ${name}`)
    }
  }

  return ejected
}

function buildStorageLookup(
  database: readonly StorageDeviceEntry[],
): Map<number, { pids: Set<number>; name: string }> {
  const lookup = new Map<number, { pids: Set<number>; name: string }>()
  for (const entry of database) {
    if (entry.storageProducts.length === 0) continue
    lookup.set(entry.vendor, { pids: new Set(entry.storageProducts), name: entry.name })
  }
  return lookup
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`
}

// ── Helper path registry ────────────────────────────────────────────────────

let registeredHelperPath: string | undefined

/**
 * Register the path to the modeswitch helper script.
 * Called by the daemon on startup — core doesn't know where daemon files are.
 */
export function registerModeswitchHelper(path: string): void {
  registeredHelperPath = path
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModeSwitchResult {
  /** Whether the device successfully re-enumerated with a new product ID */
  readonly switched: boolean
  /** The new product ID after switching (undefined if switch failed or pending) */
  readonly newProductId?: number | undefined
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a vendor-specific mode switch command and wait for re-enumeration.
 *
 * Tries each method in order. After all methods fail, tries macOS diskutil
 * eject as a last resort (works when the OS loaded a mass storage driver).
 *
 * @param location - Physical bus location of the target device, when known.
 *   Used on macOS to disambiguate two identical (same VID:PID) modems. Without
 *   it, an ambiguous target is refused rather than guessed.
 */
export async function switchDevice(
  vendorId: number,
  productId: number,
  switchMethod: SwitchMethod | readonly SwitchMethod[],
  isModemProduct: (pid: number) => boolean,
  location?: UsbLocation,
): Promise<ModeSwitchResult> {
  const methods = Array.isArray(switchMethod) ? switchMethod : [switchMethod]
  const log = (msg: string) => process.stderr.write(`[modeswitch] ${msg}\n`)

  // On macOS, diskutil eject is the ONLY reliable method.
  // - Vendor control 0xA1 corrupts device state (macOS stops loading mass storage driver)
  // - SCSI CBW via libusb always fails with LIBUSB_ERROR_OTHER (can't claim from OS driver)
  // - diskutil eject goes through macOS's own driver chain with properly initialized pipes
  if (process.platform === 'darwin') {
    const expectedLocationId =
      location !== undefined
        ? busLocationToLocationId(location.busNumber, location.portNumbers)
        : undefined
    const bsdName = await waitForWholeDisk(vendorId, productId, expectedLocationId, log)
    if (bsdName !== undefined) {
      log(`diskutil eject ${bsdName}`)
      const ejected = await ejectDisk(bsdName)
      log(`diskutil eject: ${ejected ? 'OK' : 'failed'}`)
      if (ejected) {
        const result = await pollForDevice(vendorId, isModemProduct)
        if (result.switched) {
          log(`Device switched to PID 0x${result.newProductId?.toString(16)}`)
          return result
        }
        log('diskutil eject: device did not re-enumerate')
      }
    } else {
      log('macOS: no unambiguous disk device, cannot mode-switch (device may need replug)')
    }
    // Don't fall through to vendor-control/SCSI — they don't work on macOS
    // and vendor-control corrupts device state preventing future disk creation.
    return { switched: false }
  }

  // Linux/other: use vendor-specific methods
  for (const method of methods) {
    log(`Trying method: ${method.type}`)
    try {
      await sendSwitchCommand(vendorId, productId, method)
      log(`Method ${method.type}: sent in-process, polling...`)
      const result = await pollForDevice(vendorId, isModemProduct)
      if (result.switched) {
        log(`Device switched to PID 0x${result.newProductId?.toString(16)}`)
        return result
      }
      log(`Method ${method.type}: device did not re-enumerate`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Method ${method.type} failed: ${msg}`)
    }
  }

  log('All methods exhausted, device did not switch')
  return { switched: false }
}

/**
 * Poll the USB bus until a recognized modem-mode device appears.
 */
export async function waitForDevice(
  vendor: number,
  isModemProduct: (productId: number) => boolean,
): Promise<number | undefined> {
  const result = await pollForDevice(vendor, isModemProduct)
  return result.switched ? result.newProductId : undefined
}

// ── Switch dispatch ─────────────────────────────────────────────────────────

/**
 * Route the mode switch command to the appropriate in-process implementation.
 */
async function sendSwitchCommand(
  vendorId: number,
  productId: number,
  method: SwitchMethod,
): Promise<void> {
  if (method.type === 'scsi-cbw') {
    try {
      await sendScsiCbwInProcess(vendorId, productId, method.command)
    } catch {
      // In-process claim failed (e.g. macOS driver holds interface).
      // Spawn helper as separate process — clean libusb context can claim.
      await spawnModeswitchHelper(vendorId, productId, method.command)
    }
    return
  }

  const device = openUsbDevice(vendorId, productId)
  await sendVendorControl(device, method)
}

/**
 * Spawn the modeswitch helper as a child process.
 *
 * The helper runs with a fresh libusb context, avoiding conflicts with the
 * daemon's USB hotplug watcher. On macOS, this is often the only way to
 * claim a mass storage interface held by IOUSBMassStorageDriver.
 */
async function spawnModeswitchHelper(
  vendorId: number,
  productId: number,
  cbw?: Uint8Array,
): Promise<void> {
  if (registeredHelperPath === undefined) {
    throw new DiscoveryError('Modeswitch helper not registered. Is the daemon running?')
  }
  const helperPath = registeredHelperPath
  const nodeRequire = createRequire(import.meta.url)
  const usbPath = nodeRequire.resolve('usb')
  const args = [helperPath, String(vendorId), String(productId), usbPath]
  if (cbw !== undefined) {
    args.push(Buffer.from(cbw).toString('hex'))
  }

  process.stderr.write(`[modeswitch] Spawning helper: ${args.join(' ')}\n`)

  try {
    await execFileAsync(process.execPath, args, {
      timeout: HELPER_TIMEOUT_MS,
    })
  } catch (err: unknown) {
    // The helper exits non-zero or is killed when the device disconnects
    // mid-transfer — that IS the success signal. Only a genuine spawn failure
    // (e.g. ENOENT: node binary missing) is a real error.
    if (isSpawnFailure(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new DiscoveryError(`Mode switch helper failed: ${msg}`, { cause: err })
    }
  }
}

/**
 * Distinguish a failure to spawn the process (real error) from a non-zero exit
 * or kill (expected — the device disconnected during mode switch).
 */
function isSpawnFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  // A string `code` (ENOENT, EACCES, ...) means the process never ran.
  // A numeric exit code or a kill signal means it ran and exited — expected.
  if ('code' in err && typeof err.code === 'string') return true
  return false
}

// ── In-process SCSI CBW ─────────────────────────────────────────────────────

/**
 * Send a raw SCSI CBW (Command Block Wrapper) to the device's mass storage interface.
 *
 * This sends the EXACT vendor-specific CBW — not StandardEject. Different vendors
 * use different SCSI commands for mode switching:
 * - Huawei: CDB 0x11 0x06 0x20 (proprietary)
 * - ZTE: CDB 0x85 (proprietary) or StandardEject
 */
async function sendScsiCbwInProcess(
  vendorId: number,
  productId: number,
  cbw: Uint8Array,
): Promise<void> {
  const device = openUsbDevice(vendorId, productId)
  const iface = device.interface(0)

  try {
    iface.claim()
  } catch (err: unknown) {
    closeDeviceSafe(device)
    throw new DiscoveryError('Failed to claim mass storage interface', { cause: err })
  }

  const outEp = iface.endpoints.find((ep): ep is OutEndpoint => ep.direction === 'out')
  if (outEp === undefined) {
    iface.release(() => closeDeviceSafe(device))
    throw new DiscoveryError('No bulk OUT endpoint on mass storage interface')
  }

  try {
    await new Promise<void>((resolve, reject) => {
      outEp.transfer(Buffer.from(cbw), (err: Error | undefined) => {
        if (err) {
          const msg = err.message
          // STALL/NO_DEVICE/TRANSFER_ERROR are expected — device disconnects mid-transfer
          if (
            msg.includes('STALL') ||
            msg.includes('NO_DEVICE') ||
            msg.includes('TRANSFER_ERROR')
          ) {
            resolve()
            return
          }
          reject(err)
          return
        }
        resolve()
      })
    })
  } finally {
    try {
      iface.release(() => closeDeviceSafe(device))
    } catch {
      closeDeviceSafe(device)
    }
  }
}

// ── Vendor control transfer ─────────────────────────────────────────────────

async function sendVendorControl(device: Device, method: VendorControlSwitch): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      device.controlTransfer(
        method.requestType,
        method.request,
        method.value,
        method.index,
        Buffer.alloc(0),
        (err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        },
      )
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const isExpected =
      message.includes('STALL') ||
      message.includes('TRANSFER_ERROR') ||
      message.includes('NO_DEVICE')
    if (!isExpected) {
      throw new DiscoveryError('Vendor control transfer failed', { cause: err })
    }
  }

  closeDeviceSafe(device)
}

// ── Polling ──────────────────────────────────────────────────────────────────

async function pollForDevice(
  vendor: number,
  isModemProduct: (productId: number) => boolean,
): Promise<ModeSwitchResult> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)

    const devices = getDeviceList()
    for (const dev of devices) {
      const { idVendor, idProduct } = dev.deviceDescriptor
      if (idVendor !== vendor) continue

      if (isModemProduct(idProduct)) {
        return { switched: true, newProductId: idProduct }
      }
    }
  }

  return { switched: false }
}

// ── macOS diskutil eject fallback ────────────────────────────────────────────

/**
 * Eject a USB mass storage device by BSD disk name via diskutil.
 * Some devices mode-switch when their virtual CD-ROM is ejected via the OS driver.
 */
async function ejectDisk(bsdName: string): Promise<boolean> {
  try {
    await execFileAsync('diskutil', ['eject', `/dev/${bsdName}`], { timeout: DISKUTIL_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/**
 * Wait for macOS to publish the whole-disk BSD node for a specific USB device.
 *
 * Polls the IOKit registry, selecting the device by (vendor, product) and — when
 * two identical devices are present — by physical location. If the target is
 * ambiguous (two identical devices and no location match), returns undefined
 * immediately: ejecting the wrong disk is worse than asking the user to replug.
 */
async function waitForWholeDisk(
  vendorId: number,
  productId: number,
  expectedLocationId: number | undefined,
  log: (msg: string) => void,
): Promise<string | undefined> {
  for (let waited = 0; waited < DISK_WAIT_MAX_MS; waited += DISK_WAIT_INTERVAL_MS) {
    const devices = await readIoregUsbDevices()
    const device = selectIoregDevice(devices, vendorId, productId, expectedLocationId)

    if (device === undefined && countCandidates(devices, vendorId, productId) > 1) {
      log('macOS: multiple identical devices and no location match; refusing to eject')
      return undefined
    }

    if (device !== undefined) {
      const bsdName = wholeDiskBsdName(device)
      if (bsdName !== undefined) return bsdName
    }

    log(`Waiting for macOS disk device... (${waited / 1000}s)`)
    await sleep(DISK_WAIT_INTERVAL_MS)
  }
  log('No macOS disk device appeared')
  return undefined
}

/**
 * Wait for a specific device to leave the USB bus after eject (mode switch).
 * Keyed by locationID when known, so an identical sibling device staying on the
 * bus does not keep this wait alive.
 */
async function waitForDeviceGone(
  vendorId: number,
  productId: number,
  expectedLocationId: number | undefined,
): Promise<void> {
  for (let waited = 0; waited < REENUM_WAIT_MAX_MS; waited += REENUM_WAIT_INTERVAL_MS) {
    await sleep(REENUM_WAIT_INTERVAL_MS)

    let devices: readonly IoregUsbDevice[]
    try {
      devices = await readIoregUsbDevices()
    } catch {
      return
    }

    const stillPresent = devices.some(
      (d) =>
        d.idVendor === vendorId &&
        d.idProduct === productId &&
        (expectedLocationId === undefined || d.locationID === expectedLocationId),
    )
    if (!stillPresent) return
  }
}

function countCandidates(
  devices: readonly IoregUsbDevice[],
  vendorId: number,
  productId: number,
): number {
  return devices.filter((d) => d.idVendor === vendorId && d.idProduct === productId).length
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function openUsbDevice(vendorId: number, productId: number): Device {
  const device = findByIds(vendorId, productId)
  if (!device) {
    throw new DiscoveryError('Modem disappeared during mode switching.')
  }

  try {
    device.open()
  } catch (err: unknown) {
    throw new DiscoveryError('Failed to open USB device for mode switching.', { cause: err })
  }

  try {
    device.setAutoDetachKernelDriver(true)
  } catch {
    // Not supported on all libusb backends
  }

  return device
}

function closeDeviceSafe(device: Device): void {
  try {
    device.close()
  } catch {
    // Device may already be gone after mode switch
  }
}
