/**
 * Shared display formatting for discovered modems.
 *
 * Single source of truth for device name resolution and bus location strings.
 * Used by devices, init, the direct backend, and monitor commands.
 */

import type { DiscoveredModem } from 'cellary'
import { findModemEntry, findProductConfig } from 'cellary'

import { hex4 } from './format.js'

/**
 * Resolve a human-readable device name from discovery data.
 *
 * For modem-mode devices: uses the exact model name from the product config.
 * For storage-mode devices: shows vendor name only (model unknown until mode switch).
 */
export function deviceDisplayName(d: DiscoveredModem): string {
  if (d.mode === 'emergency') return `${d.name} [BootROM]`
  if (d.mode === 'download') return `${d.name} [Download]`

  if (d.mode !== 'storage') {
    const entry = d.entry ?? findModemEntry(d.vendorId, d.productId)
    const config = findProductConfig(entry, d.productId)
    return config?.model?.name ?? d.name
  }

  // Storage mode -- we can't know the exact model until after mode switch.
  // Just show the vendor name. Don't guess from modemProducts -- listing
  // all possible models is misleading when the device could be something else entirely.
  return d.name
}

/**
 * Short USB bus location for distinguishing identical devices.
 * Returns e.g. "bus1-1.2" for bus 1, port path 1.2.
 * Serial devices use their path as the identifier.
 */
export function busLocation(d: DiscoveredModem): string {
  if (d.mode === 'serial') return d.path
  const portPath = d.portNumbers.length > 0 ? d.portNumbers.join('.') : '?'
  return `bus${d.busNumber}-${portPath}`
}

/** Format VID:PID as "12d1:1506". */
export function formatVidPid(vendorId: number, productId: number): string {
  return `${hex4(vendorId)}:${hex4(productId)}`
}
