/**
 * E8372 model-level state detectors.
 *
 * Maps E8372-specific USB product IDs to lifecycle states.
 */

import type { DeviceProbe, StateDetector } from '../../../../../../lifecycle/types.js'
import { E8372_PID_HILINK_AT, E8372_PID_HILINK_ONLY } from './index.js'

const HUAWEI_VENDOR_ID = 0x12d1
const LAYER = 'e8372'

function isHuawei(probe: DeviceProbe): boolean {
  return probe.vendorId === HUAWEI_VENDOR_ID
}

const e8372HilinkAtDetector: StateDetector = {
  stateId: 'hilink_at',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || !isHuawei(probe)) return false
    return probe.productId === E8372_PID_HILINK_AT
  },
}

const e8372HilinkOnlyDetector: StateDetector = {
  stateId: 'hilink_only',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || !isHuawei(probe)) return false
    return probe.productId === E8372_PID_HILINK_ONLY
  },
}

/** All E8372 model detectors. */
export const E8372_DETECTORS: readonly StateDetector[] = [
  e8372HilinkAtDetector,
  e8372HilinkOnlyDetector,
]
