/**
 * ZTE USB modem database entry.
 *
 * Declares known ZTE USB product IDs and their transport configuration.
 * ZTE modems present as CD-ROM in storage mode and need a vendor-specific
 * USB control request to switch to modem mode.
 *
 * ## Mode switch mechanism
 *
 * Reversed from ZTEUSBMassStorageFilter.kext (official ZTE macOS driver):
 * - **macOS**: USB vendor control transfer `bRequest=0xA1` (device-level,
 *   no interface claim needed). The kext blocks Apple's mass storage driver
 *   and sends this request directly. See `vendor/zte/README.md` for details.
 * - **Linux**: usb_modeswitch uses SCSI StandardEject + vendor SCSI 0x85.
 *   This works because Linux's usb-storage properly initializes endpoint pipes.
 *   On macOS, bulk transfers to PID 0x2000 timeout (no IOKit driver loaded).
 *
 * The vendor control approach works on both platforms and avoids the macOS
 * bulk transfer timeout issue entirely.
 */

import type { UsbModemEntry } from '../../discovery/usb-types.js'
import { mf656Model } from './models/mf656/index.js'
import { zteProfile } from './profile.js'
import {
  MF656_PID_MODEM,
  MF656_PID_STORAGE,
  MF656_PID_STORAGE_NO_AUTORUN,
  ZTE_VID,
} from './usb-ids.js'

export const zteUsbEntry: UsbModemEntry = {
  vendor: ZTE_VID,
  name: 'ZTE',
  storageProducts: [MF656_PID_STORAGE, MF656_PID_STORAGE_NO_AUTORUN],
  modemProducts: [
    {
      productId: MF656_PID_MODEM,
      transport: { type: 'usb', atInterface: 1 },
      model: mf656Model,
    },
  ],
  // USB vendor control request reversed from ZTEUSBMassStorageFilter.kext.
  // The kext sends bRequest=0xA1 to trigger firmware mode switch (re-enumeration).
  // This is a device-level control transfer — no bulk endpoints, no interface claim.
  // Works even when macOS doesn't load a mass storage driver for the device.
  switchMethod: {
    type: 'vendor-control',
    requestType: 0x40, // vendor, host-to-device, device recipient
    request: 0xa1,
    value: 0x00,
    index: 0x00,
  },
  profile: zteProfile,
}
