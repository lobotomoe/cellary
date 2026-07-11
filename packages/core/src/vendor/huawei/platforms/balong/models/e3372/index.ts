/**
 * Huawei E3372 (Stick firmware variant).
 *
 * LTE Cat4 data stick. Voice and STK are broken at firmware level:
 * - Voice: ATD returns OK but ^ORIG never arrives (call setup never starts)
 * - STK: ^STSF/^STGI exist in CLAC but ^STIN URCs never delivered
 * - AT+CCID hangs instead of returning ERROR
 *
 * @see README.md for full hardware notes and quirk documentation.
 */

import type { ModelInfo } from '../../../../../../types.js'
import { e3372PrepProfile } from './preparation.js'

// ── USB Product IDs ───────────────────────────────────────────────────────────

/** E3372 in storage / CD-ROM mode (initial state after plug-in). */
export const E3372_PID_STORAGE_A = 0x14fe

/** E3372 in storage / CD-ROM mode (alternate PID seen on some units). */
export const E3372_PID_STORAGE_B = 0x1f01

/** E3372 in Stick modem mode (serial AT ports). SCSI CBW switch produces this. */
export const E3372_PID_STICK = 0x1506

/** E3372 in HiLink mode (CDC Ethernet + web UI). Firmware-dependent. */
export const E3372_PID_HILINK = 0x14dc

export const huaweiE3372: ModelInfo = {
  name: 'Huawei E3372',
  prepProfile: e3372PrepProfile,

  capabilities: {
    voice: {
      dial: false,
      answer: false,
      hangup: false,
      dtmf: false,
      forwarding: false,
      waiting: false,
      hold: false,
      callerId: false,
    },
    stk: { supported: false },
  },

  profilePatches: {
    at: {
      // AT+CCID hangs on E3372 -- short timeout as defense-in-depth.
      // The Huawei profile overrides ICCID to AT^ICCID?, so AT+CCID
      // is never attempted in normal operation.
      commandTimeouts: {
        'AT+CCID': 1500,
      },
    },
  },
}
