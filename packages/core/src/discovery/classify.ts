/**
 * Single source of truth for "is this USB device a modem, and in what mode?".
 *
 * Both the one-shot scan (scanner.ts) and the hot-plug watcher (watcher.ts) must
 * agree on what counts as a modem — otherwise `watch()` emits events for a
 * different set of devices than `discover()` returns. This module owns that
 * decision so the two paths can never drift apart.
 *
 * Classification has two tiers:
 *  1. Database lookup by VID/PID (rich metadata, mode switching, profiles).
 *  2. CDC ACM interface probe for unknown devices (the standard AT modem class),
 *     which yields a generic `modem-usb` entry with `entry: undefined`.
 */

import type { Device } from 'usb'

import { readInterfaceInfo } from './usb-descriptors.js'
import { classifyUsbDevice } from './usb-ids.js'
import { computeUsbDeviceId, type DiscoveredModem, type UsbInterfaceInfo } from './usb-types.js'

const USB_CLASS_CDC = 0x02
const USB_SUBCLASS_ACM = 0x02

/**
 * Classify a USB device into a DiscoveredModem, or undefined if it is not a modem.
 *
 * Tries the VID/PID database first, then falls back to a CDC ACM interface probe
 * for unknown devices.
 */
export function classifyDevice(dev: Device): DiscoveredModem | undefined {
  const { idVendor, idProduct } = dev.deviceDescriptor
  const interfaces = readInterfaceInfo(dev)

  const dbMatch = classifyUsbDevice(
    idVendor,
    idProduct,
    dev.busNumber,
    dev.portNumbers ?? [],
    interfaces,
  )
  if (dbMatch !== undefined) return dbMatch

  if (interfaces !== undefined && hasCdcAcmInterface(interfaces)) {
    const busNumber = dev.busNumber
    const portNumbers = dev.portNumbers ?? []
    return {
      mode: 'modem-usb',
      vendorId: idVendor,
      productId: idProduct,
      deviceId: computeUsbDeviceId(idVendor, busNumber, portNumbers),
      name: `USB Modem ${formatHex(idVendor)}:${formatHex(idProduct)}`,
      entry: undefined,
      busNumber,
      portNumbers,
    }
  }

  return undefined
}

/**
 * The stable device identity for a Device, computed the same way classification
 * does (vendorId + bus location). Works even for a just-detached device whose
 * interface descriptors can no longer be read.
 */
export function deviceIdForDevice(dev: Device): string {
  const { idVendor } = dev.deviceDescriptor
  return computeUsbDeviceId(idVendor, dev.busNumber, dev.portNumbers ?? [])
}

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
