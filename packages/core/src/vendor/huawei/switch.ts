/**
 * Huawei USB mode-switch constants.
 *
 * Two methods are known to work for switching Huawei USB modems
 * from storage/CD-ROM mode to modem mode:
 *
 * 1. Vendor control transfer (preferred) — fast, no mass storage interface needed.
 * 2. SCSI CBW command — legacy fallback, classic usb_modeswitch approach.
 */

import type { ScsiCbwSwitch, VendorControlSwitch } from '../../discovery/modeswitch.js'

/**
 * Huawei vendor control transfer.
 *
 * Sends USB control request (requestType=0x40, request=0xA1) to trigger
 * modem re-enumeration. The device typically returns STALL (expected -- it
 * disconnects mid-transfer).
 *
 * Confirmed behavior on E8372H-153 fw 21.328.03.00.00:
 *   - From 0x14db (HiLink-only, AT^U2DIAG=0): causes RESET only -- device
 *     comes back as 0x14db, not 0x1566. Does not switch PID.
 *   - From storage PIDs (0x1442, 0x1f01): device boots to modem mode, but
 *     the resulting PID depends on the stored AT^U2DIAG value:
 *       AT^U2DIAG=256 → 0x1566 (HiLink + AT)
 *       AT^U2DIAG=0   → 0x14db (HiLink-only, even from storage mode)
 *
 * On E3372 and devices where AT^U2DIAG=256 is stored, the storage→modem
 * path (0x1f01 → 0x1566) works as expected.
 *
 * Discovered via reverse engineering the Huawei HiLink desktop software.
 */
export const HUAWEI_VENDOR_SWITCH: VendorControlSwitch = {
  type: 'vendor-control',
  requestType: 0x40,
  request: 0xa1,
  value: 0x00,
  index: 0x00,
}

/**
 * Huawei SCSI CBW fallback switch command.
 *
 * This is a Huawei proprietary message wrapped in a USB Mass Storage
 * CBW (Command Block Wrapper) format. Equivalent to usb_modeswitch
 * with the standard Huawei config.
 *
 * Not used by default (vendor control is simpler and proven on tested devices),
 * but kept for devices that may not support vendor control.
 */
export const HUAWEI_SCSI_SWITCH: ScsiCbwSwitch = {
  type: 'scsi-cbw',
  command: new Uint8Array([
    0x55,
    0x53,
    0x42,
    0x43, // dCBWSignature: "USBC"
    0x12,
    0x34,
    0x56,
    0x78, // dCBWTag
    0x00,
    0x00,
    0x00,
    0x00, // dCBWDataTransferLength
    0x00,
    0x00,
    0x00, //       bmCBWFlags + bCBWLUN + bCBWCBLength
    0x11,
    0x06,
    0x20,
    0x00, // CBWCB: Huawei vendor-specific command
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
}
