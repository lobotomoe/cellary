/**
 * Modem auto-provisioning.
 *
 * Takes a discovered modem (or discovers one), switches modes if needed,
 * and returns transport configuration ready for Modem.open().
 *
 * This is the "actor" layer -- unlike scanUsb/discover (read-only), provision()
 * mutates device state (mode switches, USB re-enumeration).
 */

import { findByIds } from 'usb'

import { DiscoveryError } from '../errors.js'
import { genericProfile } from '../protocols/at/profile.js'
import type { DeviceProfile, ModelInfo, ModemDriver, TransportConfig } from '../types.js'
import { switchDevice, waitForDevice } from './modeswitch.js'
import { discover } from './scanner.js'
import { findProductConfig, isModemProduct } from './usb-ids.js'
import type { DiscoveredModem, UsbModemEntry } from './usb-types.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProvisionResult {
  /** Physical transport connection parameters */
  readonly transport: TransportConfig
  /** Which driver to use for communication over the transport */
  readonly driver: ModemDriver
  /** Recommended modem profile */
  readonly profile: DeviceProfile
  /** Per-model metadata from USB database (undefined if not in database) */
  readonly model?: ModelInfo | undefined
}

/**
 * Optional hooks for mode switching.
 *
 * On macOS, the daemon's USB hotplug watcher keeps IOKit references active,
 * preventing child processes from claiming USB interfaces. These hooks let
 * the caller (pipeline/pool) pause USB monitoring before the mode switch
 * and resume it after.
 */
export interface ProvisionHooks {
  /** Called before USB mode switch. Should release USB monitoring resources. */
  readonly beforeModeSwitch?: () => void
  /** Called after USB mode switch (in finally block). Should resume USB monitoring. */
  readonly afterModeSwitch?: () => void
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Find a modem, switch modes if needed, and return ready-to-use transport configuration.
 *
 * Full auto-provisioning flow:
 * 1. If no modem given, discover() and pick the first found
 * 2. If device is in storage mode, send mode switch command and wait for re-enumeration
 * 3. If device is in vendor HTTP API mode and has an AT mode alternative, switch to AT mode
 * 4. Return TransportConfig + driver + recommended profile ready for Modem.open()
 *
 * Throws DiscoveryError with clear, user-friendly messages.
 */
export async function provision(
  modem?: DiscoveredModem,
  hooks?: ProvisionHooks,
): Promise<ProvisionResult> {
  let target: DiscoveredModem

  if (modem !== undefined) {
    target = modem
  } else {
    const discovered = await discover()
    const first = discovered[0]
    if (first === undefined) {
      throw new DiscoveryError('No supported modem found. Connect your modem and try again.')
    }
    target = first
  }

  return resolveTransport(target, hooks)
}

// ── Internals ────────────────────────────────────────────────────────────────

async function resolveTransport(
  modem: DiscoveredModem,
  hooks?: ProvisionHooks,
): Promise<ProvisionResult> {
  if (modem.mode === 'emergency' || modem.mode === 'download') {
    const modeLabel = modem.mode === 'emergency' ? 'BootROM' : 'download'
    throw new DiscoveryError(
      `Device is in ${modeLabel} mode and cannot be used as a modem. ` +
        'Use the flash tools to interact with this device.',
    )
  }

  if (modem.mode === 'serial') {
    if (!modem.entry) {
      throw new DiscoveryError(
        `Unknown serial modem (VID 0x${modem.vendorId.toString(16)}, PID 0x${modem.productId.toString(16)}). ` +
          'Serial provisioning requires a database entry with a modem profile.',
      )
    }
    const productConfig = findProductConfig(modem.entry, modem.productId)
    const result: ProvisionResult = {
      transport: { type: 'serial', path: modem.path },
      driver: { kind: 'at' },
      profile: modem.entry.profile,
    }
    return productConfig?.model !== undefined ? { ...result, model: productConfig.model } : result
  }

  if (modem.mode === 'http') {
    const { entry: httpEntry } = modem
    if (!httpEntry) {
      throw new DiscoveryError(
        `Unknown HTTP modem (VID 0x${modem.vendorId.toString(16)}, PID 0x${modem.productId.toString(16)}). ` +
          'HTTP provisioning requires a database entry with driver and profile.',
      )
    }
    const productConfig = findProductConfig(httpEntry, modem.productId)
    const transport = productConfig?.transport

    // Dual-mode device: switch to AT mode as part of preparation
    if (
      transport?.type === 'http' &&
      transport.atModeProductId !== undefined &&
      transport.switchToAtMode !== undefined
    ) {
      const httpModem = { ...modem, entry: httpEntry }
      return resolveHttpToAt(httpModem, transport.atModeProductId, transport.switchToAtMode)
    }

    // API-only device: use HTTP transport directly
    if (!productConfig?.driver) {
      throw new DiscoveryError(
        `No driver registered for ${modem.name} (product 0x${modem.productId.toString(16)}). ` +
          'The USB database entry is missing a driver field for this HTTP-mode product.',
      )
    }
    const result: ProvisionResult = {
      transport: { type: 'http', url: modem.url },
      driver: productConfig.driver,
      profile: httpEntry.profile,
    }
    return productConfig.model !== undefined ? { ...result, model: productConfig.model } : result
  }

  // 'storage' or 'modem-usb' -- USB transport
  const { entry } = modem
  let productId = modem.productId

  if (modem.mode === 'storage') {
    if (!entry) {
      throw new DiscoveryError(
        `Unknown storage device (VID 0x${modem.vendorId.toString(16)}, PID 0x${productId.toString(16)}). ` +
          'Mode switching requires a database entry with a switch method.',
      )
    }

    if (entry.switchMethod === undefined) {
      throw new DiscoveryError(
        'Device is in storage mode but no switch method is defined. ' +
          'The USB database entry is incomplete.',
      )
    }

    // Pause the daemon's USB hotplug watcher before mode switching.
    // On macOS, the SCSI CBW is delegated to a LaunchAgent (user bootstrap)
    // because the daemon's system bootstrap can't claim kext-held interfaces.
    // Pausing prevents the daemon from interfering during device re-enumeration.
    hooks?.beforeModeSwitch?.()
    try {
      const switchResult = await switchDevice(
        modem.vendorId,
        modem.productId,
        entry.switchMethod,
        (pid) => isModemProduct(entry, pid),
      )

      if (!switchResult.switched) {
        // On macOS the only switch mechanism the OS permits is a standard eject
        // (diskutil). Devices that need a vendor-specific USB switch command --
        // e.g. the classic Huawei SCSI/control message -- do not respond to a
        // plain eject, and macOS blocks sending that command directly (the mass
        // storage driver owns the interface). Replugging just returns them to
        // storage mode, so the generic "try replugging" advice would loop forever.
        if (process.platform === 'darwin') {
          throw new DiscoveryError(
            'On macOS this device could not be switched to modem mode. macOS only permits ' +
              'a standard eject to trigger a switch, and this device did not respond to it -- ' +
              'it most likely requires a vendor-specific USB switch command that macOS does ' +
              'not allow. Use it on Linux, or (for a WiFi hotspot device) connect over its ' +
              'WiFi network instead.',
          )
        }
        throw new DiscoveryError(
          'Mode switch completed but the modem did not re-enumerate. ' +
            'Try unplugging the modem, waiting a few seconds, and plugging it back in.',
        )
      }

      // On macOS, newProductId is undefined (stale libusb cache after agent mode switch).
      // The daemon's USB watcher will detect the re-enumerated device and restart
      // the pipeline. Throw a non-fatal error to exit this pipeline run cleanly.
      if (switchResult.newProductId === undefined) {
        throw new DiscoveryError('Mode switch command sent. Device will re-appear automatically.')
      }

      productId = switchResult.newProductId
    } finally {
      hooks?.afterModeSwitch?.()
    }
  }

  // Unknown device in modem-usb mode: auto-detect interface, use generic profile
  if (!entry) {
    const interfaceNumber = resolveUsbInterface(modem.vendorId, productId, 'auto')
    return {
      transport: { type: 'usb', vendorId: modem.vendorId, productId, interfaceNumber },
      driver: { kind: 'at' },
      profile: genericProfile,
    }
  }

  const productConfig = findProductConfig(entry, productId)
  if (!productConfig) {
    throw new DiscoveryError(
      `Unknown modem product ID 0x${productId.toString(16)}. ` +
        'The device switched to an unrecognized mode.',
    )
  }

  const { transport: productTransport } = productConfig

  if (productTransport.type === 'http') {
    if (!productConfig.driver) {
      throw new DiscoveryError(
        `No driver registered for product 0x${productId.toString(16)}. ` +
          'The USB database entry is missing a driver field for this HTTP-mode product.',
      )
    }
    const result: ProvisionResult = {
      transport: { type: 'http', url: productTransport.defaultUrl },
      driver: productConfig.driver,
      profile: entry.profile,
    }
    return productConfig.model !== undefined ? { ...result, model: productConfig.model } : result
  }

  if (productTransport.type === 'usb') {
    const interfaceNumber = resolveUsbInterface(
      entry.vendor,
      productId,
      productTransport.atInterface,
    )
    const result: ProvisionResult = {
      transport: {
        type: 'usb',
        vendorId: entry.vendor,
        productId,
        interfaceNumber,
        assertDtr: productTransport.assertDtr,
      },
      driver: { kind: 'at' },
      profile: entry.profile,
    }
    return productConfig.model !== undefined ? { ...result, model: productConfig.model } : result
  }

  // productTransport.type === 'serial'
  throw new DiscoveryError(
    `Device 0x${productId.toString(16)} is declared as serial in the database. ` +
      'It should appear as a serial port -- use discover() instead.',
  )
}

/**
 * Switch a vendor HTTP API device to AT mode, then resolve its USB transport.
 *
 * Called by resolveTransport() when a device is found in vendor HTTP API mode
 * but has a known AT mode product ID. Attempts USB vendor control first, then
 * falls back to the vendor HTTP API.
 */
async function resolveHttpToAt(
  modem: DiscoveredModem & { mode: 'http'; entry: UsbModemEntry },
  atProductId: number,
  switchToAtMode: (url: string) => Promise<void>,
): Promise<ProvisionResult> {
  const { entry } = modem
  const isKnownModem = (pid: number) => isModemProduct(entry, pid)

  // Attempt 1: USB vendor control transfer.
  // The Huawei vendor command (0x40/0xA1) was designed for storage->modem switching
  // but may also trigger re-enumeration from vendor HTTP API mode. Try it first since it
  // requires no network access and is instantaneous.
  if (entry.switchMethod !== undefined) {
    try {
      const switchResult = await switchDevice(
        modem.vendorId,
        modem.productId,
        entry.switchMethod,
        isKnownModem,
      )
      if (switchResult.switched && switchResult.newProductId === atProductId) {
        return resolveUsbProductTransport(entry, atProductId)
      }
    } catch (_usbErr: unknown) {
      // USB vendor control failed (permissions, device busy, rejected command).
      // Non-fatal: fall through to vendor HTTP API path below.
    }
  }

  // Attempt 2: vendor HTTP API.
  // Requires the network interface to be up (device URL must be reachable).
  try {
    await switchToAtMode(modem.url)
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : 'failed'
    throw new DiscoveryError(
      `Could not switch ${modem.name} to AT mode.\n` +
        `USB vendor transfer: device not reachable or command rejected.\n` +
        `vendor HTTP API: ${errMessage}\n\n` +
        `Manual steps: open ${modem.url}, go to Settings > Device mode, select modem/stick mode.`,
      { cause: err },
    )
  }

  const newProductId = await waitForDevice(entry.vendor, isKnownModem)

  if (newProductId !== atProductId) {
    throw new DiscoveryError(
      `vendor HTTP API mode switch was sent but device did not re-enumerate as AT mode ` +
        `(expected 0x${atProductId.toString(16)}, ` +
        `got ${newProductId !== undefined ? `0x${newProductId.toString(16)}` : 'nothing'}).`,
    )
  }

  return resolveUsbProductTransport(entry, atProductId)
}

function resolveUsbProductTransport(entry: UsbModemEntry, productId: number): ProvisionResult {
  const productConfig = findProductConfig(entry, productId)
  if (!productConfig || productConfig.transport.type !== 'usb') {
    throw new DiscoveryError(
      `Unknown modem product ID 0x${productId.toString(16)}. ` +
        'The device switched to an unrecognized mode.',
    )
  }
  const interfaceNumber = resolveUsbInterface(
    entry.vendor,
    productId,
    productConfig.transport.atInterface,
  )
  const result: ProvisionResult = {
    transport: {
      type: 'usb',
      vendorId: entry.vendor,
      productId,
      interfaceNumber,
      assertDtr: productConfig.transport.assertDtr,
    },
    driver: { kind: 'at' },
    profile: entry.profile,
  }
  return productConfig.model !== undefined ? { ...result, model: productConfig.model } : result
}

// ── Interface detection ─────────────────────────────────────────────────────

const USB_CLASS_VENDOR = 0xff
const USB_TRANSFER_BULK = 0x02

/**
 * Resolve an AT interface spec to a concrete interface number.
 *
 * - number   -> returned as-is (no device access needed)
 * - number[] -> findByIds, check bulk IN+OUT endpoints, return first valid candidate
 * - 'auto'   -> findByIds, scan all interfaces, return first vendor-class (0xFF) with bulk IN+OUT
 */
function resolveUsbInterface(
  vendorId: number,
  productId: number,
  spec: number | readonly number[] | 'auto',
): number {
  // Fixed number: trust the database, no USB descriptor access needed
  if (typeof spec === 'number') {
    return spec
  }

  // Need device descriptors for 'auto' or array
  const usbDevice = findByIds(vendorId, productId)
  if (!usbDevice) {
    throw new DiscoveryError(
      'Modem disappeared during provisioning. Reconnect the device and try again.',
    )
  }

  const interfaces = usbDevice.configDescriptor?.interfaces ?? []

  if (spec === 'auto') {
    for (let i = 0; i < interfaces.length; i++) {
      const altSettings = interfaces[i]
      if (!altSettings) continue
      for (const alt of altSettings) {
        if (alt.bInterfaceClass === USB_CLASS_VENDOR && hasBulkEndpoints(alt.endpoints)) {
          return i
        }
      }
    }
    throw new DiscoveryError(
      `Could not auto-detect AT command interface on modem 0x${productId.toString(16)}. ` +
        'The device may use an unsupported interface layout.',
    )
  }

  // number[] -- try each candidate
  for (const candidate of spec) {
    const altSettings = interfaces[candidate]
    if (!altSettings) continue
    for (const alt of altSettings) {
      if (hasBulkEndpoints(alt.endpoints)) {
        return candidate
      }
    }
  }

  throw new DiscoveryError(
    `Could not find AT command interface on modem 0x${productId.toString(16)}. ` +
      'The device may use an unsupported interface layout.',
  )
}

function hasBulkEndpoints(
  endpoints: readonly { bmAttributes: number; bEndpointAddress: number }[],
): boolean {
  const hasIn = endpoints.some(
    (ep) => (ep.bmAttributes & 0x03) === USB_TRANSFER_BULK && (ep.bEndpointAddress & 0x80) !== 0,
  )
  const hasOut = endpoints.some(
    (ep) => (ep.bmAttributes & 0x03) === USB_TRANSFER_BULK && (ep.bEndpointAddress & 0x80) === 0,
  )
  return hasIn && hasOut
}
