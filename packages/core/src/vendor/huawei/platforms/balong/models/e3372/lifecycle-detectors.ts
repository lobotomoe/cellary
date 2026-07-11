/**
 * E3372 model-level state detectors.
 *
 * Maps E3372-specific USB product IDs to lifecycle states.
 * PID 0x1506 = stick mode, PID 0x14dc = HiLink firmware AT mode.
 */

import type { DeviceProbe, StateDetector } from '../../../../../../lifecycle/types.js'
import { E3372_PID_HILINK, E3372_PID_STICK } from './index.js'

const HUAWEI_VENDOR_ID = 0x12d1
const LAYER = 'e3372'

function isHuawei(probe: DeviceProbe): boolean {
  return probe.vendorId === HUAWEI_VENDOR_ID
}

/** E3372 PIDs that indicate stick/AT mode. */
const STICK_PIDS = new Set([E3372_PID_STICK, E3372_PID_HILINK])

const e3372StickDetector: StateDetector = {
  stateId: 'stick',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || !isHuawei(probe)) return false
    return STICK_PIDS.has(probe.productId)
  },
}

/** All E3372 model detectors. */
export const E3372_DETECTORS: readonly StateDetector[] = [e3372StickDetector]
