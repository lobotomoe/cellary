/**
 * USB descriptor reading utilities.
 *
 * Shared between scanner.ts and watcher.ts. Isolates the `usb` package
 * dependency for reading interface descriptors from a USB device.
 */

import type { Device } from 'usb'

import type { UsbInterfaceInfo } from './usb-types.js'

/**
 * Read USB interface descriptors from a device without opening it.
 * Returns undefined if descriptors are unavailable (e.g. insufficient privileges).
 */
export function readInterfaceInfo(dev: Device): UsbInterfaceInfo[][] | undefined {
  try {
    const config = dev.configDescriptor
    if (!config) return undefined
    return config.interfaces.map((alts) =>
      alts.map((alt) => ({
        bInterfaceClass: alt.bInterfaceClass,
        bInterfaceSubClass: alt.bInterfaceSubClass,
        bInterfaceProtocol: alt.bInterfaceProtocol,
      })),
    )
  } catch {
    // configDescriptor may throw on some platforms without elevated privileges
    return undefined
  }
}
