/**
 * HiLink runtime model resolution.
 *
 * USB PIDs like 0x14db are shared across multiple Huawei Balong devices
 * (E8372, E5573, etc.) in HiLink-only mode. The USB PID alone cannot
 * identify the model. This module resolves the actual model by querying
 * the HiLink basic_information API endpoint (unauthenticated).
 *
 * The devicename field from basic_information is matched against known
 * prefixes to resolve a ModelInfo. Unknown device names return undefined,
 * letting the caller fall back to a generic profile.
 */

import type { ModelInfo } from '../../types.js'
import { huaweiE5573 } from './platforms/balong/models/e5573/index.js'
import { huaweiE8372 } from './platforms/balong/models/e8372/index.js'

/**
 * Map of HiLink devicename prefixes to ModelInfo.
 *
 * The basic_information API returns devicenames like "E8372h-153" or "E5573Bs-320".
 * We match on the model family prefix (case-insensitive) to handle variant suffixes.
 *
 * Add new entries here when supporting new Huawei models with shared PIDs.
 */
const HILINK_MODEL_PREFIXES: readonly { readonly prefix: string; readonly model: ModelInfo }[] = [
  { prefix: 'e8372', model: huaweiE8372 },
  { prefix: 'e5573', model: huaweiE5573 },
]

/**
 * Resolve a ModelInfo from a HiLink devicename string.
 *
 * Returns undefined if the devicename doesn't match any known model,
 * which is the correct outcome -- the caller uses a generic profile.
 */
export function resolveHiLinkModel(deviceName: string): ModelInfo | undefined {
  const lower = deviceName.toLowerCase()
  const match = HILINK_MODEL_PREFIXES.find((entry) => lower.startsWith(entry.prefix))
  return match?.model
}
