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
import { readInterfaceInfo } from './usb-descriptors.js'
import { classifyUsbDevice, findModemEntry } from './usb-ids.js'
import { computeUsbDeviceId, type DiscoveredModem, type UsbInterfaceInfo } from './usb-types.js'

// ── USB interface class constants ────────────────────────────────────────────

const USB_CLASS_CDC = 0x02
const USB_SUBCLASS_ACM = 0x02

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
    const { idVendor, idProduct } = dev.deviceDescriptor
    const interfaces = readInterfaceInfo(dev)

    // Fast path: VID/PID in database
    const modem = classifyUsbDevice(
      idVendor,
      idProduct,
      dev.busNumber,
      dev.portNumbers ?? [],
      interfaces,
    )
    if (modem !== undefined) {
      discovered.push(modem)
      continue
    }

    // Fallback: probe interface classes for CDC ACM (standard AT modem)
    if (interfaces !== undefined && hasCdcAcmInterface(interfaces)) {
      const busNumber = dev.busNumber
      const portNumbers = dev.portNumbers ?? []
      discovered.push({
        mode: 'modem-usb',
        vendorId: idVendor,
        productId: idProduct,
        deviceId: computeUsbDeviceId(idVendor, busNumber, portNumbers),
        name: `USB Modem ${formatHex(idVendor)}:${formatHex(idProduct)}`,
        entry: undefined,
        busNumber,
        portNumbers,
      })
    }
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

  // Prefer serial over USB for the same physical device
  const serialKeys = new Set(serialModems.map((m) => `${m.vendorId}:${m.productId}`))
  const filteredUsb = usbModems.filter((m) => !serialKeys.has(`${m.vendorId}:${m.productId}`))

  return [...serialModems, ...filteredUsb]
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Check whether any interface group contains a CDC ACM interface.
 * CDC ACM (class 0x02, subclass 0x02) is the standard USB class for AT modems.
 */
function hasCdcAcmInterface(interfaces: readonly UsbInterfaceInfo[][]): boolean {
  return interfaces.some((alts) =>
    alts.some(
      (alt) => alt.bInterfaceClass === USB_CLASS_CDC && alt.bInterfaceSubClass === USB_SUBCLASS_ACM,
    ),
  )
}

function formatHex(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`
}

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

    const key = `${vendorId}:${productId}`
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
