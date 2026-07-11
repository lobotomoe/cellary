/**
 * Alcatel USB modem database entry.
 *
 * Alcatel LINKZONE MW45V (Ucom uFi MW45V) — pocket MiFi router.
 * PID 0x0908 is modem mode (bDeviceClass=2). No storage mode PID known.
 *
 * USB provides CDC-ECM (Ethernet) only — no AT serial ports.
 * Web management via JSON-RPC API at http://192.168.1.1/jrd/webapi.
 * Requires manual IP setup (DHCP unreliable): 192.168.1.x/24 on USB interface.
 *
 * Hardware-tested on macOS Sequoia (en13 via AppleUserECM driver).
 * See README.md for full API documentation.
 */

import type { UsbModemEntry } from '../../discovery/usb-types.js'
import { alcatelProfile } from './profile.js'
import { ALCATEL_VID, MOBILEBROADBAND_PID } from './usb-ids.js'

export const alcatelUsbEntry: UsbModemEntry = {
  vendor: ALCATEL_VID,
  name: 'Alcatel',
  storageProducts: [],
  modemProducts: [
    {
      productId: MOBILEBROADBAND_PID,
      transport: { type: 'http', defaultUrl: 'http://192.168.1.1' },
      driver: { kind: 'vendor', api: 'alcatel-jrd' },
      model: { name: 'Alcatel LINKZONE MW45V' },
    },
  ],
  profile: alcatelProfile,
}
