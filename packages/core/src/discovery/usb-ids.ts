/**
 * USB device database for known cellular modems.
 *
 * Maps vendor/product IDs to metadata: switch methods,
 * AT command interface numbers, recommended profiles.
 *
 * New vendors/devices are added as entries to USB_MODEM_DATABASE.
 * Each vendor owns its entry — see vendor/<name>/usb-entries.ts.
 */

import { alcatelUsbEntry } from '../vendor/alcatel/usb-entries.js'
import { huaweiUsbEntry } from '../vendor/huawei/usb-entries.js'
import { msm8916OemUsbEntry } from '../vendor/msm8916-oem/usb-entries.js'
import { zteUsbEntry } from '../vendor/zte/usb-entries.js'
import {
  computeUsbDeviceId,
  type DiscoveredModem,
  type UsbInterfaceInfo,
  type UsbModemEntry,
  type UsbProductConfig,
} from './usb-types.js'

// ── Database ─────────────────────────────────────────────────────────────────

export const USB_MODEM_DATABASE: readonly UsbModemEntry[] = [
  alcatelUsbEntry,
  huaweiUsbEntry,
  msm8916OemUsbEntry,
  zteUsbEntry,
]

// ── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Find a modem entry matching the given vendor and product IDs.
 * Checks both storage-mode and modem-mode product IDs.
 */
export function findModemEntry(vendorId: number, productId: number): UsbModemEntry | undefined {
  return USB_MODEM_DATABASE.find(
    (entry) =>
      entry.vendor === vendorId &&
      (entry.storageProducts.includes(productId) ||
        entry.emergencyProducts?.includes(productId) === true ||
        entry.modemProducts.some((p) => p.productId === productId) ||
        entry.resolveUnknownProduct?.(productId) !== undefined),
  )
}

/**
 * Find the product-specific configuration for a given modem product ID.
 * Returns AT interface number and protocol for the specific device variant.
 * Returns undefined if the entry is undefined (unknown device, not in database).
 */
export function findProductConfig(
  entry: UsbModemEntry | undefined,
  productId: number,
): UsbProductConfig | undefined {
  if (!entry) return undefined
  return (
    entry.modemProducts.find((p) => p.productId === productId) ??
    entry.resolveUnknownProduct?.(productId)
  )
}

/**
 * Check whether a product ID is a recognized modem-mode PID for the given entry.
 *
 * Checks both the static modemProducts array and the dynamic resolver (e.g. kext database).
 * Used as a predicate for waitForDevice/switchDevice after mode switching.
 */
export function isModemProduct(entry: UsbModemEntry, productId: number): boolean {
  return (
    entry.modemProducts.some((p) => p.productId === productId) ||
    entry.resolveUnknownProduct?.(productId) !== undefined
  )
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify a USB device by VID/PID into a DiscoveredModem.
 *
 * Returns undefined if the device is not a known modem.
 * This is the single source of truth for VID/PID -> DiscoveredModem mapping,
 * used by both scan() and watch().
 */
export function classifyUsbDevice(
  vendorId: number,
  productId: number,
  busNumber: number,
  portNumbers: readonly number[],
  interfaces?: readonly UsbInterfaceInfo[][] | undefined,
): DiscoveredModem | undefined {
  const entry = findModemEntry(vendorId, productId)
  if (!entry) return undefined

  const deviceId = computeUsbDeviceId(vendorId, busNumber, portNumbers)

  if (entry.emergencyProducts?.includes(productId) === true) {
    return {
      mode: 'emergency',
      vendorId,
      productId,
      deviceId,
      name: entry.name,
      entry,
      busNumber,
      portNumbers,
    }
  }

  if (entry.storageProducts.includes(productId)) {
    return {
      mode: 'storage',
      vendorId,
      productId,
      deviceId,
      name: entry.name,
      entry,
      busNumber,
      portNumbers,
    }
  }

  const productConfig = findProductConfig(entry, productId)
  if (!productConfig) return undefined

  // Dual-purpose PID check: verify this device is actually in modem mode
  // by inspecting USB interface descriptors. If verifyMode returns false,
  // the device is in firmware download mode (e.g. Huawei HDLC flash).
  if (productConfig.verifyMode !== undefined && interfaces !== undefined) {
    if (!productConfig.verifyMode(interfaces)) {
      return {
        mode: 'download',
        vendorId,
        productId,
        deviceId,
        name: entry.name,
        entry,
        busNumber,
        portNumbers,
      }
    }
  }

  const { transport } = productConfig

  if (transport.type === 'http') {
    return {
      mode: 'http',
      vendorId,
      productId,
      deviceId,
      name: entry.name,
      entry,
      url: transport.defaultUrl,
      busNumber,
      portNumbers,
    }
  }

  if (transport.type === 'usb') {
    return {
      mode: 'modem-usb',
      vendorId,
      productId,
      deviceId,
      name: entry.name,
      entry,
      busNumber,
      portNumbers,
    }
  }

  // 'serial': these devices appear as serial ports, not as USB events
  return undefined
}
