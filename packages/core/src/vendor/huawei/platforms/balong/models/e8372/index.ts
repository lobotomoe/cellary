/**
 * Huawei E8372 (HiLink/Wingle variant).
 *
 * LTE Cat4 WiFi hotspot running HiLink firmware.
 *
 * @see README.md for full hardware notes and mode-switch documentation.
 */

import type { ModelInfo } from '../../../../../../types.js'
import type { HuaweiPidConfig } from '../../../../state.js'
import { e8372PrepProfile } from './preparation.js'

// ── USB Product IDs ───────────────────────────────────────────────────────────

/**
 * E8372 in HiLink + AT mode (AT^U2DIAG=256 stored).
 * 9 interfaces: CDC-ECM, PCUI (AT), c_shell, a_shell, 3g_diag, GPS, 4g_diag,
 * mass storage. Default mode when device ships.
 */
export const E8372_PID_HILINK_AT = 0x1566

/**
 * E8372 in HiLink-only mode (AT^U2DIAG=0 stored).
 * CDC-ECM + mass storage only. No serial AT interface.
 * Reached by sending AT^U2DIAG=0 from an AT port while at 0x1566.
 */
export const E8372_PID_HILINK_ONLY = 0x14db

/**
 * E8372H-153 storage mode PID.
 * Produced by POST /CGI with switchMode(0) from HiLink HTTP API.
 * Interface 0: vendor class 255 (AT port, OUT:0x01 IN:0x81).
 * Interface 1: mass storage class 8.
 *
 * AT commands (ATI, AT) work on interface 0; AT^U2DIAG returns ERROR.
 * HUAWEI_VENDOR_SWITCH from this PID boots to modem mode, but the resulting
 * PID depends on the stored AT^U2DIAG value (see HUAWEI_VENDOR_SWITCH docs).
 *
 * Not the same as E3372's 0x1f01 -- this PID is specific to E8372H-153.
 */
export const E8372_PID_STORAGE = 0x1442

/**
 * E8372H-153 CD-ROM mode PID.
 * Appears after AT^RESET while in storage mode (0x1442).
 * macOS mounts the virtual CD-ROM (HiLink.app.zip + Installer.app).
 * HUAWEI_VENDOR_SWITCH from this PID also boots to modem mode (same caveat
 * as 0x1442: resulting PID depends on stored AT^U2DIAG value).
 */
export const E8372_PID_CDROM = 0x1f01

/**
 * Pre-built PID configuration for the E8372 state machine.
 * Pass to detectHuaweiState() and navigateToAtMode().
 */
export const E8372_STATE_CONFIG: HuaweiPidConfig = {
  vendorId: 0x12d1,
  storagePids: [E8372_PID_STORAGE, E8372_PID_CDROM],
  hilinkOnlyPid: E8372_PID_HILINK_ONLY,
  hilinkAtPid: E8372_PID_HILINK_AT,
  baseUrl: 'http://192.168.8.1',
}

export const huaweiE8372: ModelInfo = {
  name: 'Huawei E8372',
  prepProfile: e8372PrepProfile,
}
