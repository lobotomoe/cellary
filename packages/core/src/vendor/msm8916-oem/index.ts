/**
 * MSM8916 OEM vendor module.
 *
 * Covers Chinese 4G USB WiFi dongles (TianJie, UFI, UZ801, etc.)
 * based on Qualcomm MSM8916/MDM9207 running Android internally.
 *
 * These devices expose:
 * - RNDIS over USB (default PID 0xF00E)
 * - HTTP management API at 192.168.100.1
 * - Optional AT serial ports (after USB composition switch via funcNo=1022)
 *
 * Status: RNDIS transport proven end-to-end (USB -> RNDIS -> TCP -> HTTP -> JSON).
 * Full HTTP API accessible over USB. Device has thermal issues on sustained use.
 */

export type { Uz801BoardVersion } from './models/index.js'
export {
  isUz801,
  UFI_BOARD_VARIANTS,
  UZ801_BOARD_VERSIONS,
  UZ801_BRAND_NAMES,
  UZ801_PID_EDL,
  UZ801_PID_RNDIS,
  UZ801_PID_RNDIS_ADB,
  UZ801_THERMAL,
  uz801PrepProfile,
} from './models/index.js'
export { uz801Model } from './models/uz801/index.js'
export { msm8916OemPlugin } from './plugin.js'
export { msm8916OemProfile } from './profile.js'
export { MifiAdapter } from './protocols/mifi/adapter.js'
export type {
  MifiDeviceInfo,
  MifiLoginRequest,
  MifiNetworkStatus,
  MifiRawEnvelope,
  MifiSmsSendRequest,
  MifiUsbCompositionRequest,
} from './protocols/mifi/api-types.js'
export { FUNC, mifiDeviceInfoSchema, mifiNetworkStatusSchema } from './protocols/mifi/api-types.js'
export { MifiApiError, MifiClient } from './protocols/mifi/client.js'
export { msm8916OemResolver } from './resolver.js'
export { msm8916OemUsbEntry } from './usb-entries.js'
export { MIFI_DEFAULT_CREDENTIALS, MIFI_DEFAULT_HOST, MIFI_PIDS, QUALCOMM_VID } from './usb-ids.js'
