/**
 * USB modem scanner.
 *
 * Scans the USB bus and serial ports for cellular modems.
 * Read-only enumeration -- does not modify device state.
 *
 * Two discovery paths:
 * 1. **Database lookup** — VID/PID matched in USB_MODEM_DATABASE (fast, rich metadata)
 * 2. **Interface class probing** — CDC ACM (0x02/0x02) detected on unknown device
 *    (generic, entry: undefined, works with generic 3GPP profile)
 *
 * For provisioning (mode switching, transport resolution), see provisioner.ts.
 */

import { SerialPort } from 'serialport'
import { getDeviceList } from 'usb'
import { classifyDevice } from './classify.js'
import { findModemEntry } from './usb-ids.js'
import type { DiscoveredModem } from './usb-types.js'

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the USB bus for cellular modems.
 *
 * Synchronous. Returns devices in any mode: storage (needs switch), modem-usb,
 * or http. Does NOT include serial-port modems — use discover() for those.
 *
 * Devices not in the USB modem database are still discovered if they expose
 * a CDC ACM interface (standard AT modem class). These have `entry: undefined`.
 */
export function scanUsb(): DiscoveredModem[] {
  const discovered: DiscoveredModem[] = []
  for (const dev of getDeviceList()) {
    const modem = classifyDevice(dev)
    if (modem !== undefined) discovered.push(modem)
  }
  return discovered
}

/**
 * Scan for all discoverable modems: USB bus + serial ports.
 *
 * Asynchronous (serial port enumeration requires an async OS call).
 * Does not require elevated privileges for enumeration.
 *
 * When the same device is visible both as USB and serial, serial is preferred
 * (no sudo needed, already in modem mode).
 */
export async function discover(): Promise<DiscoveredModem[]> {
  const [usbResult, serialResult] = await Promise.allSettled([
    Promise.resolve(scanUsb()),
    scanSerial(),
  ])

  const usbModems = usbResult.status === 'fulfilled' ? usbResult.value : []
  const serialModems = serialResult.status === 'fulfilled' ? serialResult.value : []

  return [...serialModems, ...dedupeUsbAgainstSerial(usbModems, serialModems)]
}

/**
 * Prefer the serial view of a device over its USB view, WITHOUT hiding a distinct
 * device that merely shares a VID:PID.
 *
 * On Linux a single modem appears both as a serial port and (via libusb) as a USB
 * device — those must collapse to one entry. But two identical modems share a
 * VID:PID, so a blanket "drop every USB entry with a matching serial VID:PID"
 * hides the second device. Instead, drop only as many USB entries as there are
 * serial twins to pair them with; any surplus USB device is genuinely separate
 * and stays.
 */
function dedupeUsbAgainstSerial(
  usbModems: readonly DiscoveredModem[],
  serialModems: readonly DiscoveredModem[],
): DiscoveredModem[] {
  const serialTwinBudget = new Map<string, number>()
  for (const modem of serialModems) {
    const key = `${modem.vendorId}:${modem.productId}`
    serialTwinBudget.set(key, (serialTwinBudget.get(key) ?? 0) + 1)
  }

  const kept: DiscoveredModem[] = []
  for (const modem of usbModems) {
    const key = `${modem.vendorId}:${modem.productId}`
    const budget = serialTwinBudget.get(key) ?? 0
    if (budget > 0) {
      serialTwinBudget.set(key, budget - 1)
      continue
    }
    kept.push(modem)
  }
  return kept
}

// ── Internals ────────────────────────────────────────────────────────────────

async function scanSerial(): Promise<(DiscoveredModem & { mode: 'serial' })[]> {
  const ports = await SerialPort.list()
  const seen = new Set<string>()
  const result: (DiscoveredModem & { mode: 'serial' })[] = []

  const sorted = [...ports].sort((a, b) => (a.path < b.path ? -1 : 1))

  for (const port of sorted) {
    if (!port.vendorId || !port.productId) continue

    const vendorId = Number.parseInt(port.vendorId, 16)
    const productId = Number.parseInt(port.productId, 16)
    if (Number.isNaN(vendorId) || Number.isNaN(productId)) continue

    // One physical modem exposes several serial ports (AT, PPP, diag) that share
    // a USB serial number, so collapse by serial number to a single entry. Two
    // identical modems have DISTINCT serial numbers and must stay separate — a
    // VID:PID key would wrongly merge them into one. Without a serial number
    // (rare for real modems) fall back to VID:PID as a best-effort collapse.
    const serial = port.serialNumber
    const key =
      serial !== undefined && serial.length > 0 ? `sn:${serial}` : `id:${vendorId}:${productId}`
    if (seen.has(key)) continue
    seen.add(key)

    const entry = findModemEntry(vendorId, productId)
    if (!entry) continue

    result.push({
      mode: 'serial',
      path: port.path,
      deviceId: `serial:${port.path}`,
      name: entry.name,
      vendorId,
      productId,
      entry,
    })
  }

  return result
}
