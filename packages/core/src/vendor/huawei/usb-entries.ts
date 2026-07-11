/**
 * Huawei USB modem database entry.
 *
 * Declares all known Huawei USB product IDs, their mode-switch method,
 * recommended profile, and per-product transport configuration.
 * Consumed by the discovery layer to identify and provision Huawei devices.
 *
 * Tested/confirmed devices are listed explicitly in modemProducts.
 * Unknown PIDs fall through to resolveUnknownProduct(), which consults
 * the kext PID database (pid-database.ts) for interface role mappings.
 */

import type { UsbModemEntry, UsbProductConfig } from '../../discovery/usb-types.js'
import { lookupHuaweiPid } from './pid-database.js'
import {
  E3372_PID_HILINK,
  E3372_PID_STICK,
  E3372_PID_STORAGE_A,
  E3372_PID_STORAGE_B,
} from './platforms/balong/models/e3372/index.js'
import { E8372_PID_HILINK_AT } from './platforms/balong/models/e8372/index.js'
import { huaweiE3372, huaweiE8372 } from './platforms/balong/models/index.js'
import {
  E173_PID_MODEM,
  E173_PID_STORAGE,
  huaweiE173,
} from './platforms/qualcomm/models/e173/index.js'
import { huaweiProfile } from './profile.js'
import { HILINK_DRIVER } from './protocols/hilink/index.js'
import { HUAWEI_SCSI_SWITCH, HUAWEI_VENDOR_SWITCH } from './switch.js'

const HUAWEI_VENDOR_ID = 0x12d1

// BootROM emergency mode PID (needle method / failed boot)
const PID_BOOTROM = 0x1443

// Storage-mode PIDs present on some older Huawei units, not tied to a specific model.
// 0x1446: seen on E3372 and others
// 0x1001: legacy storage PID (E169, E220, etc.)
// (E173's storage PID 0x1C0B lives with its model -- see qualcomm/models/e173.)
const PID_STORAGE_MISC_A = 0x1446
const PID_STORAGE_MISC_B = 0x1001

// Alternate storage PID found in Huawei's ArConfig.dat (official macOS software)
const PID_STORAGE_ALT = 0x1f02

// MBIM-capable storage PIDs (ArConfig.dat FILTER_MBIM_ID section)
// These are storage PIDs for devices that boot into MBIM mode, not CDC-ECM.
// Recognized so we don't attempt mode-switch to AT (they won't become AT devices).
const PID_STORAGE_MBIM_A = 0x157d
const PID_STORAGE_MBIM_B = 0x158b

// Shared HiLink-only PID across Balong devices (E8372, E5573, and others).
// When AT^U2DIAG=0 is stored, the device enumerates with CDC-ECM + mass storage
// only, no serial AT interface. Model cannot be determined from USB PID alone --
// runtime resolution via HiLink basic_information API is required.
const PID_BALONG_HILINK_ONLY = 0x14db

// PID 0x1f01 is a shared Balong storage/CD-ROM PID used by E3372, E8372, E5573,
// and likely other devices. E3372_PID_STORAGE_B and E8372_PID_CDROM are aliases.
// Only one entry is needed in the storage list.

/**
 * Resolve an unknown Huawei modem-mode PID using the kext database.
 *
 * Called as fallback when a PID is not in the explicit modemProducts array.
 * Returns a generic UsbProductConfig with the PCUI interface from the kext,
 * or undefined if the PID is not in the kext database or has no PCUI interface.
 */
function resolveFromKext(productId: number): UsbProductConfig | undefined {
  const info = lookupHuaweiPid(productId)
  if (info?.pcui === undefined) return undefined
  return {
    productId,
    transport: { type: 'usb', atInterface: info.pcui },
  }
}

export const huaweiUsbEntry: UsbModemEntry = {
  vendor: HUAWEI_VENDOR_ID,
  name: 'Huawei',
  storageProducts: [
    E3372_PID_STORAGE_A,
    E3372_PID_STORAGE_B, // also E8372_PID_CDROM (same PID: 0x1f01)
    PID_STORAGE_ALT,
    PID_STORAGE_MBIM_A,
    PID_STORAGE_MBIM_B,
    PID_STORAGE_MISC_A,
    PID_STORAGE_MISC_B,
    E173_PID_STORAGE,
  ],
  modemProducts: [
    { productId: E3372_PID_STICK, transport: { type: 'usb', atInterface: 0 }, model: huaweiE3372 },
    {
      productId: E8372_PID_HILINK_AT,
      transport: { type: 'usb', atInterface: 2 },
      model: huaweiE8372,
    },
    {
      productId: PID_BALONG_HILINK_ONLY,
      // Shared PID: E8372, E5573, and other Balong HiLink-only devices.
      // Model resolved at runtime via HiLink basic_information API.
      // Some firmware uses 192.168.1.1 instead (found in ArConfig.dat).
      // Tested devices: E8372H-153, E5573Bs-320 both use 192.168.8.1.
      transport: { type: 'http', defaultUrl: 'http://192.168.8.1' },
      driver: HILINK_DRIVER,
    },
    { productId: E3372_PID_HILINK, transport: { type: 'usb', atInterface: 0 }, model: huaweiE3372 },
    {
      // E173 (Qualcomm) serial modem mode. PCUI/AT is interface 2.
      productId: E173_PID_MODEM,
      transport: { type: 'usb', atInterface: 2 },
      model: huaweiE173,
    },
  ],
  resolveUnknownProduct: resolveFromKext,
  emergencyProducts: [PID_BOOTROM],
  switchMethod: [HUAWEI_VENDOR_SWITCH, HUAWEI_SCSI_SWITCH],
  profile: huaweiProfile,
}
