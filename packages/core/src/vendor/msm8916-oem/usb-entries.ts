/**
 * MSM8916 OEM USB modem database entry.
 *
 * Declares known MSM8916 OEM USB product IDs and their transport configuration.
 * Consumed by the discovery layer to identify and provision these devices.
 *
 * Unlike Huawei, these devices have no storage mode — they boot directly into
 * a modem or RNDIS composition. No mode switching is needed.
 */

import type { UsbModemEntry } from '../../discovery/usb-types.js'
import { UZ801_PID_MODEM_DIAG_ADB, UZ801_PID_RNDIS, uz801Model } from './models/uz801/index.js'
import { msm8916OemProfile } from './profile.js'
import { QUALCOMM_VID } from './usb-ids.js'

export const msm8916OemUsbEntry: UsbModemEntry = {
  vendor: QUALCOMM_VID,
  name: 'MSM8916 OEM',
  storageProducts: [],
  modemProducts: [
    {
      productId: UZ801_PID_MODEM_DIAG_ADB,
      transport: { type: 'usb', atInterface: 2, assertDtr: true },
      model: uz801Model,
    },
    {
      productId: UZ801_PID_RNDIS,
      transport: { type: 'http', defaultUrl: 'http://192.168.100.1' },
      driver: { kind: 'vendor', api: 'mifi' },
      model: uz801Model,
    },
  ],
  // No switchMethod — device has no storage mode, boots directly into modem composition
  profile: msm8916OemProfile,
}
