export { HUAWEI_LAYER } from './lifecycle.js'
export {
  createHuaweiLifecycle,
  type HuaweiLifecycleOptions,
  huaweiLifecycle,
} from './lifecycle-definition.js'
export { HUAWEI_DETECTORS } from './lifecycle-detectors.js'
export {
  HUAWEI_PID_COUNT,
  type HuaweiPidInfo,
  hasEcmCapability,
  isKnownHuaweiModemPid,
  lookupHuaweiPid,
} from './pid-database.js'
export { BALONG_LAYER } from './platforms/balong/lifecycle.js'
export { BALONG_DETECTORS } from './platforms/balong/lifecycle-detectors.js'
export {
  E3372_PID_HILINK,
  E3372_PID_STICK,
  E3372_PID_STORAGE_A,
  E3372_PID_STORAGE_B,
} from './platforms/balong/models/e3372/index.js'
export { E3372_LAYER } from './platforms/balong/models/e3372/lifecycle.js'
export { E3372_DETECTORS } from './platforms/balong/models/e3372/lifecycle-detectors.js'
export {
  E8372_PID_CDROM,
  E8372_PID_HILINK_AT,
  E8372_PID_HILINK_ONLY,
  E8372_PID_STORAGE,
  E8372_STATE_CONFIG,
} from './platforms/balong/models/e8372/index.js'
export { E8372_LAYER } from './platforms/balong/models/e8372/lifecycle.js'
export { E8372_DETECTORS } from './platforms/balong/models/e8372/lifecycle-detectors.js'
export { huaweiE3372, huaweiE8372 } from './platforms/balong/models/index.js'
export { QUALCOMM_LAYER } from './platforms/qualcomm/lifecycle.js'
export { QUALCOMM_DETECTORS } from './platforms/qualcomm/lifecycle-detectors.js'
export {
  E173_PID_MODEM,
  E173_PID_STORAGE,
  huaweiE173,
} from './platforms/qualcomm/models/e173/index.js'
export { huaweiPlugin } from './plugin.js'
export { huaweiProfile } from './profile.js'
export {
  fetchHiLinkSession,
  HILINK_DRIVER,
  HILINK_ERR_ACCOUNT_LOCKED,
  HILINK_ERR_MODE_NOT_SUPPORTED,
  HiLinkAdapter,
  type HiLinkCredentials,
  type HiLinkSession,
  hashHiLinkPassword,
  loginHiLink,
  requestHiLinkModeSwitch,
} from './protocols/index.js'
export { huaweiResolver } from './resolver.js'
export {
  detectHuaweiState,
  type HuaweiDeviceState,
  type HuaweiPidConfig,
  type NavigateOptions,
  navigateToAtMode,
} from './state.js'
export { HUAWEI_SCSI_SWITCH, HUAWEI_VENDOR_SWITCH } from './switch.js'
export { huaweiUsbEntry } from './usb-entries.js'
