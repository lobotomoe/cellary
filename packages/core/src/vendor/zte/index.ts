/**
 * ZTE vendor module.
 *
 * Covers ZTE 3G/4G USB modems (MF656, MF190, etc.) based on
 * Qualcomm MSM chipsets with ZTE firmware.
 *
 * These devices expose:
 * - Virtual CD-ROM in storage mode (PID 0x2000)
 * - AT serial via vendor-class USB interfaces after mode switch
 * - Standard 3GPP AT + ZTE vendor extensions (+ZPAS, +ZRSSI, AT+ICCID)
 * - Qualcomm vendor URCs ($QCSIMSTAT, $CREG, $QCSYSMODE)
 *
 * Status: MF656 hardware-tested, AT communication verified via libusb.
 */

export { MF656_PID_MODEM, MF656_PID_STORAGE, mf656Model } from './models/mf656/index.js'
export { ztePlugin } from './plugin.js'
export { zteProfile } from './profile.js'
export { zteResolver } from './resolver.js'
export { zteUsbEntry } from './usb-entries.js'
export { MF656_PID_STORAGE_NO_AUTORUN, ZTE_VID } from './usb-ids.js'
