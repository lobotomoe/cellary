/**
 * Shared types for USB modem discovery.
 *
 * Neutral file with zero imports from discovery/ or vendor/ — breaks the
 * circular dependency between usb-ids.ts (database) and vendor usb-entries
 * (data providers), and between scanner.ts and usb-ids.ts.
 */

import type { DeviceProfile, ModelInfo, ModemDriver } from '../types.js'
import type { ScsiCbwSwitch, SwitchMethod, VendorControlSwitch } from './modeswitch.js'

export type { ScsiCbwSwitch, SwitchMethod, VendorControlSwitch }

/**
 * Result of vendor plugin identification.
 *
 * Returned by VendorPlugin.identify() to provide model name and protocol
 * list without full adapter creation.
 */
export interface DeviceIdentification {
  /** Resolved display name (e.g. "E8372"). Undefined if unknown. */
  readonly displayName?: string | undefined
  /** Expected protocol names in priority order. */
  readonly protocols: readonly string[]
}

/** Minimal USB interface descriptor shape for mode verification (avoids coupling to `usb` package). */
export interface UsbInterfaceInfo {
  readonly bInterfaceClass: number
  readonly bInterfaceSubClass: number
  readonly bInterfaceProtocol: number
}

/**
 * How to communicate with this product in modem mode.
 *
 * - usb        — AT via USB bulk endpoints (libusb). atInterface: number selects
 *                which USB interface to claim. 'auto' = detect from descriptors.
 *                assertDtr raises DTR/RTS on open for Qualcomm serial_smd ports.
 * - http      — Vendor HTTP management API (e.g. Huawei HiLink). No USB access
 *                needed; communicate over virtual Ethernet. atModeProductId links
 *                to the sibling USB AT mode product (if the device is dual-mode).
 * - serial — exposed as OS serial port (ttyUSB, ttyACM, etc.).
 *            Identified at provision time via serial port scan.
 */
export type ProductTransport =
  | {
      readonly type: 'usb'
      readonly atInterface: number | readonly number[] | 'auto'
      /**
       * Raise DTR/RTS (via SET_CONTROL_LINE_STATE, plus SET_LINE_CODING) on open.
       * Required by Qualcomm serial_smd interfaces (e.g. MSM8916 UZ801), which
       * buffer AT data and stay silent until DTR is asserted. Defaults to false.
       */
      readonly assertDtr?: boolean
    }
  | {
      readonly type: 'http'
      readonly defaultUrl: string
      /**
       * USB product ID for this device in AT/modem mode, if the device supports
       * both vendor HTTP API and AT modes. Used by switchModemToAtMode() to identify
       * the target product ID after switching.
       */
      readonly atModeProductId?: number | undefined
      /**
       * Vendor-specific function to request the device to switch from vendor HTTP API
       * mode to AT mode. Called by switchModemToAtMode() as the HTTP fallback path.
       * Must be provided when atModeProductId is set.
       */
      readonly switchToAtMode?: ((url: string) => Promise<void>) | undefined
    }
  | { readonly type: 'serial' }

/** Per-product modem configuration after mode switch */
export interface UsbProductConfig {
  /** USB product ID in modem mode */
  readonly productId: number
  /** How to communicate with this product */
  readonly transport: ProductTransport
  /**
   * Driver to use for this product.
   * Defaults to `{ kind: 'at' }` when omitted (covers USB and serial products).
   * Must be set explicitly for vendor HTTP API products.
   */
  readonly driver?: ModemDriver | undefined
  /** Per-model metadata. Undefined means "use vendor defaults, trust AT+CLAC." */
  readonly model?: ModelInfo | undefined
  /**
   * Runtime check: is this device actually in the expected modem mode?
   * Called with USB interface descriptors during classification.
   * Return false to reclassify this device as 'download' mode.
   * Omit for single-purpose products (always modem mode).
   */
  readonly verifyMode?: ((interfaces: readonly UsbInterfaceInfo[][]) => boolean) | undefined
}

export interface UsbModemEntry {
  /** USB vendor ID */
  readonly vendor: number
  /** Human-readable vendor/device name */
  readonly name: string
  /** Product IDs for storage/CD-ROM mode (device needs mode switch) */
  readonly storageProducts: readonly number[]
  /** Product IDs for emergency/BootROM mode (raw USB bulk, no modem command interface) */
  readonly emergencyProducts?: readonly number[] | undefined
  /** Modem-mode products with per-product AT interface configuration */
  readonly modemProducts: readonly UsbProductConfig[]
  /**
   * Fallback resolver for product IDs not in the static modemProducts array.
   * Called by findProductConfig() when the PID has no explicit entry.
   * Used to provide generic support for known-but-untested devices
   * (e.g. Huawei kext PID database).
   */
  readonly resolveUnknownProduct?: ((productId: number) => UsbProductConfig | undefined) | undefined
  /**
   * Methods to switch from storage to modem mode, tried in order.
   * Array: first match wins (e.g. vendor control first, SCSI CBW fallback).
   * Single value: only one method.
   */
  readonly switchMethod?: SwitchMethod | readonly SwitchMethod[] | undefined
  /** Recommended modem profile for this device */
  readonly profile: DeviceProfile
}

/** USB bus location, stable across PID changes (mode switching). */
interface UsbLocation {
  /** USB bus number (host controller). */
  readonly busNumber: number
  /** USB port path (e.g. [1, 2] for port 1.2). Empty if unavailable. */
  readonly portNumbers: readonly number[]
}

/** Common fields shared by all discovered modem variants. */
interface DiscoveredModemBase {
  readonly vendorId: number
  readonly productId: number
  readonly name: string
  /**
   * Stable identity string, computed once at discovery time.
   * Same physical USB port = same identity, even when PID changes during mode switching.
   * Serial devices use `serial:<path>`.
   */
  readonly deviceId: string
  /**
   * Database entry for this device, if the VID/PID is in our USB modem database.
   * Undefined for unknown devices discovered via interface class probing (CDC ACM, etc.).
   * Consumers that need entry data (mode switching, profile selection) must handle undefined.
   */
  readonly entry: UsbModemEntry | undefined
}

/**
 * A modem discovered on this system, unified across all connection modes.
 *
 * Discriminated by `mode`:
 * - storage    — device is in CD-ROM/mass storage mode, needs mode switch before use
 * - modem-usb  — USB direct AT (libusb), needs elevated privileges on macOS
 * - http       — vendor HTTP management API (e.g. Huawei E8372), no USB access needed
 * - serial     — exposed as OS serial port, no elevated privileges needed
 * - download   — device is in firmware download mode (e.g. Huawei HDLC flash, PID 0x1C05)
 * - emergency  — device is in BootROM mode (raw USB bulk, no modem command interface)
 */
export type DiscoveredModem =
  | (UsbLocation &
      DiscoveredModemBase & {
        readonly mode: 'emergency'
      })
  | (UsbLocation &
      DiscoveredModemBase & {
        readonly mode: 'download'
      })
  | (UsbLocation &
      DiscoveredModemBase & {
        readonly mode: 'storage'
      })
  | (UsbLocation &
      DiscoveredModemBase & {
        readonly mode: 'modem-usb'
      })
  | (UsbLocation &
      DiscoveredModemBase & {
        /** Vendor HTTP management API. The specific protocol is vendor-defined. */
        readonly mode: 'http'
        readonly url: string
      })
  | (DiscoveredModemBase & {
      readonly mode: 'serial'
      readonly path: string
    })

/**
 * Build a stable device identity string from USB bus location.
 * Same physical port = same identity, even when PID changes during mode switching.
 */
export function computeUsbDeviceId(
  vendorId: number,
  busNumber: number,
  portNumbers: readonly number[],
): string {
  const portPath = portNumbers.length > 0 ? portNumbers.join('.') : '0'
  return `${vendorId}:${busNumber}-${portPath}`
}
