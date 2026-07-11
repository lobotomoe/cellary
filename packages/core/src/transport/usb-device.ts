/**
 * Shared USB device acquisition with reference counting.
 *
 * node-usb's findByIds returns the SAME cached Device object for a given
 * physical device. When multiple adapters use one device on different
 * interfaces (e.g. AT on interface 2 + ADB on interface 4 of an MSM8916
 * composite), each opens and closes it — but libusb has a single handle per
 * device. Opening twice, or closing while another holder still has pending
 * transfers, throws ("Can't close device with a pending request").
 *
 * This registry ref-counts acquisitions: the device is opened on the first
 * acquire and closed only when the last holder releases. Interface claim and
 * release stay per-adapter — they operate on different interfaces.
 */

import { type Device, findByIds } from 'usb'

import { TransportError } from '../errors.js'

const refCounts = new Map<Device, number>()

function label(vendorId: number, productId: number): string {
  return `${vendorId.toString(16)}:${productId.toString(16)}`
}

/**
 * Acquire — and open on first use — the USB device for the given VID/PID.
 * Every acquire must be paired with exactly one releaseUsbDevice().
 *
 * @throws TransportError if the device is absent or cannot be opened
 */
export function acquireUsbDevice(vendorId: number, productId: number): Device {
  const device = findByIds(vendorId, productId)
  if (!device) {
    throw new TransportError(`USB device not found: ${label(vendorId, productId)}`)
  }

  const count = refCounts.get(device) ?? 0
  if (count === 0) {
    try {
      device.open()
    } catch (err: unknown) {
      throw new TransportError(
        `Failed to open USB device ${label(vendorId, productId)}. ` +
          'You may need elevated privileges (sudo).',
        { cause: err },
      )
    }
  }
  refCounts.set(device, count + 1)
  return device
}

/**
 * Release a device acquired via acquireUsbDevice(). Closes the underlying
 * libusb handle only when the last holder releases. Extra releases are ignored.
 */
export function releaseUsbDevice(device: Device): void {
  const count = refCounts.get(device)
  if (count === undefined) return

  if (count <= 1) {
    refCounts.delete(device)
    try {
      device.close()
    } catch {
      // Device may already be gone (unplugged); nothing to recover.
    }
  } else {
    refCounts.set(device, count - 1)
  }
}

/**
 * Force-close a device regardless of ref-count. Used by reset(), which tears
 * the device down for every holder (a USB bus reset re-enumerates the device).
 * Clears the ref-count so a later re-acquire re-opens cleanly.
 */
export function forceCloseUsbDevice(device: Device): void {
  refCounts.delete(device)
  try {
    device.close()
  } catch {
    // Device may already be gone after reset.
  }
}
