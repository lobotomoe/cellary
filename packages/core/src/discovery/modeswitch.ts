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
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

import type { Device, OutEndpoint } from 'usb'
import { findByIds, getDeviceList } from 'usb'

import { DiscoveryError } from '../errors.js'
import { sleep } from '../utils.js'

const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 6

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
  const storageDevices = findStorageDevicesViaIoreg(database)

  if (storageDevices.length === 0) return []

  log(`Preflight: found ${storageDevices.length} storage-mode device(s)`)

  const ejected: Array<{ vendorId: number; productId: number }> = []

  for (const { vendorId, productId, name } of storageDevices) {
    log(`Preflight: ${name} (${hex(vendorId)}:${hex(productId)}) needs mode switch`)

    const bsdName = await waitForBsdName(vendorId, productId, log)
    if (bsdName === undefined) {
      log(`Preflight: no disk device for ${name}, skipping`)
      continue
    }

    log(`Preflight: diskutil eject ${bsdName}`)
    const ok = tryDiskutilEject(vendorId, productId)
    if (ok) {
      log(`Preflight: ejected ${name}, waiting for re-enumeration...`)
      ejected.push({ vendorId, productId })
      // Wait for device to re-enumerate before processing next device
      await waitForIoregPidChange(vendorId, productId)
    } else {
      log(`Preflight: diskutil eject failed for ${name}`)
    }
  }

  return ejected
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`
}

/**
 * Find USB devices on the bus that are in storage mode, using ioreg only.
 * No libusb calls — purely reads the IOKit registry.
 */
function findStorageDevicesViaIoreg(
  database: readonly StorageDeviceEntry[],
): Array<{ vendorId: number; productId: number; name: string }> {
  // Build a lookup: VID -> Set<storage PIDs>
  const storageLookup = new Map<number, { pids: Set<number>; name: string }>()
  for (const entry of database) {
    if (entry.storageProducts.length === 0) continue
    storageLookup.set(entry.vendor, {
      pids: new Set(entry.storageProducts),
      name: entry.name,
    })
  }

  if (storageLookup.size === 0) return []

  // Parse ioreg for USB devices
  let output: string
  try {
    output = execFileSync('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
  } catch {
    return []
  }

  const found: Array<{ vendorId: number; productId: number; name: string }> = []
  const vidPattern = /"idVendor" = (\d+)/g
  const pidPattern = /"idProduct" = (\d+)/g

  // Extract all VID/PID pairs from ioreg output
  const vids = [...output.matchAll(vidPattern)].map((m) => Number(m[1]))
  const pids = [...output.matchAll(pidPattern)].map((m) => Number(m[1]))

  // VIDs and PIDs appear in device-level order; pair them by index
  const count = Math.min(vids.length, pids.length)
  for (let i = 0; i < count; i++) {
    const vid = vids[i]
    const pid = pids[i]
    if (vid === undefined || pid === undefined) continue
    const vendorInfo = storageLookup.get(vid)
    if (vendorInfo?.pids.has(pid)) {
      found.push({ vendorId: vid, productId: pid, name: vendorInfo.name })
    }
  }

  return found
}

/**
 * Wait for a device to change PID in ioreg (indicating mode switch completed).
 * Polls ioreg — no libusb involved.
 */
async function waitForIoregPidChange(vendorId: number, oldProductId: number): Promise<void> {
  const MAX_WAIT_MS = 20_000
  const INTERVAL_MS = 2000

  for (let waited = 0; waited < MAX_WAIT_MS; waited += INTERVAL_MS) {
    await sleep(INTERVAL_MS)

    try {
      const output = execFileSync('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], {
        encoding: 'utf-8',
        timeout: 5000,
      })
      // Check if the old storage PID is still present
      const vidStr = `"idVendor" = ${vendorId}`
      const pidStr = `"idProduct" = ${oldProductId}`
      if (output.includes(vidStr) && output.includes(pidStr)) {
        continue // still in storage mode
      }
      // Old PID gone — device either switched or disconnected
      return
    } catch {
      return
    }
  }
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

/** SCSI CBW mode switch -- sends vendor command via mass storage bulk OUT endpoint */
export interface ScsiCbwSwitch {
  readonly type: 'scsi-cbw'
  readonly command: Uint8Array
}

/** USB vendor control transfer -- device-level control request, no interface needed */
export interface VendorControlSwitch {
  readonly type: 'vendor-control'
  readonly requestType: number
  readonly request: number
  readonly value: number
  readonly index: number
}

/** How to trigger USB re-enumeration from storage mode to modem mode */
export type SwitchMethod = ScsiCbwSwitch | VendorControlSwitch

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
 */
export async function switchDevice(
  vendorId: number,
  productId: number,
  switchMethod: SwitchMethod | readonly SwitchMethod[],
  isModemProduct: (pid: number) => boolean,
): Promise<ModeSwitchResult> {
  const methods = Array.isArray(switchMethod) ? switchMethod : [switchMethod]
  const log = (msg: string) => process.stderr.write(`[modeswitch] ${msg}\n`)

  // On macOS, diskutil eject is the ONLY reliable method.
  // - Vendor control 0xA1 corrupts device state (macOS stops loading mass storage driver)
  // - SCSI CBW via libusb always fails with LIBUSB_ERROR_OTHER (can't claim from OS driver)
  // - diskutil eject goes through macOS's own driver chain with properly initialized pipes
  if (process.platform === 'darwin') {
    const bsdName = await waitForBsdName(vendorId, productId, log)
    if (bsdName !== undefined) {
      log(`diskutil eject ${bsdName}`)
      const ejected = tryDiskutilEject(vendorId, productId)
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
      log('macOS: no disk device, cannot mode-switch (device may need replug)')
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
      spawnModeswitchHelper(vendorId, productId, method.command)
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
function spawnModeswitchHelper(vendorId: number, productId: number, cbw?: Uint8Array): void {
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
    execFileSync(process.execPath, args, {
      timeout: 20_000,
      stdio: 'pipe',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // Helper exits non-zero when device disconnects mid-transfer — that's success
    if (!msg.includes('SIGTERM') && !msg.includes('exit code')) {
      throw new DiscoveryError(`Mode switch helper failed: ${msg}`, { cause: err })
    }
  }
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
 * Eject a USB mass storage device via diskutil.
 * Some devices mode-switch when their virtual CD-ROM is ejected via the OS driver.
 */
function tryDiskutilEject(vendorId: number, productId: number): boolean {
  const bsdName = findBsdNameForUsb(vendorId, productId)
  if (bsdName === undefined) return false

  try {
    execFileSync('diskutil', ['eject', bsdName], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Find the BSD disk name (e.g. "/dev/disk8") for a USB device by VID/PID.
 * Scans ioreg output for the device's VID+PID, then finds "BSD Name" in its subtree.
 */
/**
 * Wait for macOS to create a BSD disk device for the USB modem.
 * The driver chain (IOUSBMassStorageDriver -> SCSI -> IOMedia -> BSD) takes 1-5s.
 */
async function waitForBsdName(
  vendorId: number,
  productId: number,
  log: (msg: string) => void,
): Promise<string | undefined> {
  const MAX_WAIT_MS = 15_000
  const INTERVAL_MS = 1000
  for (let waited = 0; waited < MAX_WAIT_MS; waited += INTERVAL_MS) {
    const name = findBsdNameForUsb(vendorId, productId)
    if (name !== undefined) return name
    log(`Waiting for macOS disk device... (${waited / 1000}s)`)
    await sleep(INTERVAL_MS)
  }
  log('No macOS disk device appeared')
  return undefined
}

function findBsdNameForUsb(vendorId: number, productId: number): string | undefined {
  try {
    const output = execFileSync('ioreg', ['-r', '-c', 'IOUSBHostDevice', '-l', '-w0'], {
      encoding: 'utf-8',
      timeout: 5000,
    })

    const vidStr = `"idVendor" = ${vendorId}`
    const pidStr = `"idProduct" = ${productId}`
    const bsdPattern = /"BSD Name" = "(disk\d+)"/

    const vidIndex = output.indexOf(vidStr)
    if (vidIndex < 0) return undefined

    const pidIndex = output.indexOf(pidStr)
    if (pidIndex < 0) return undefined

    const searchStart = Math.min(vidIndex, pidIndex)
    const tail = output.slice(searchStart)

    const nextDevice = tail.indexOf('<class IOUSBHostDevice')
    const searchRegion = nextDevice > 0 ? tail.slice(0, nextDevice) : tail
    const bsdMatch = bsdPattern.exec(searchRegion)
    if (bsdMatch !== null) {
      const [, name] = bsdMatch
      if (name !== undefined) return `/dev/${name}`
    }
  } catch {
    // ioreg failed
  }

  return undefined
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
