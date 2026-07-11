/**
 * Huawei E5573 (Mobile WiFi / MiFi variant).
 *
 * LTE Cat4 pocket WiFi hotspot running HiLink firmware.
 * Shares PID 0x14db (HiLink-only) with E8372 and other Balong devices.
 * Identified at runtime via HiLink basic_information API (devicename: "E5573Bs-320").
 *
 * Known variants:
 * - E5573Bs-320: firmware 21.333.63.00.67, classify: mobile-wifi
 *
 * STK: untested, assumed firmware-owned (same as E8372 HiLink).
 */

import type { ModelInfo } from '../../../../../../types.js'
import { e5573PrepProfile } from './preparation.js'

export const huaweiE5573: ModelInfo = {
  name: 'Huawei E5573',
  prepProfile: e5573PrepProfile,

  capabilities: {
    stk: { supported: false },
  },
}
