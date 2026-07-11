/**
 * Huawei vendor-level state detectors.
 *
 * This file is intentionally empty of PID-specific logic. Vendor-level
 * detectors only handle states that can be detected without model knowledge.
 *
 * Model-specific PIDs live in:
 *   - platforms/balong/models/e3372/lifecycle-detectors.ts
 *   - platforms/balong/models/e8372/lifecycle-detectors.ts
 *
 * Platform-specific detectors live in:
 *   - platforms/balong/lifecycle-detectors.ts   (balong_download)
 *   - platforms/qualcomm/lifecycle-detectors.ts (E173 stick, PID 0x1C05)
 *
 * HUAWEI_DETECTORS is kept as an aggregate export for backward compatibility.
 */

import type { StateDetector } from '../../lifecycle/types.js'
import { BALONG_DETECTORS } from './platforms/balong/lifecycle-detectors.js'
import { E3372_DETECTORS } from './platforms/balong/models/e3372/lifecycle-detectors.js'
import { E8372_DETECTORS } from './platforms/balong/models/e8372/lifecycle-detectors.js'
import { QUALCOMM_DETECTORS } from './platforms/qualcomm/lifecycle-detectors.js'

/** All Huawei state detectors (vendor + platform + model). */
export const HUAWEI_DETECTORS: readonly StateDetector[] = [
  ...E8372_DETECTORS,
  ...E3372_DETECTORS,
  ...BALONG_DETECTORS,
  ...QUALCOMM_DETECTORS,
]
