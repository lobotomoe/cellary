/**
 * Preparation profiles.
 *
 * A PrepProfile defines which health checks to run and what limitations
 * to report for a specific device. Vendor plugins provide per-model profiles;
 * resolveProfile() picks the right one with a generic fallback.
 */

import type { ModelInfo } from '../types.js'
import { registrationCheck } from './registration-check.js'
import { simCheck } from './sim-check.js'
import type { PrepProfile } from './types.js'

// ── Generic profile ──────────────────────────────────────────────────────────

/** Default profile for standard 3GPP AT modems. Runs SIM and registration checks. */
export const genericPrepProfile: PrepProfile = {
  name: 'Generic modem',
  checks: [simCheck, registrationCheck],
  limitations: [],
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * VendorPlugin-like interface for profile resolution.
 * Avoids importing the full VendorPlugin type here (which lives in protocols/).
 */
interface ProfileProvider {
  preparationProfile?(
    discovered: { vendorId: number; productId: number },
    model: ModelInfo | undefined,
  ): PrepProfile | undefined
}

/**
 * Resolve the preparation profile for a device.
 *
 * 1. Model carries its own profile (preferred -- no plugin dispatch needed)
 * 2. Ask the vendor plugin (fallback for models without per-model profiles)
 * 3. Fall back to the generic profile
 */
export function resolveProfile(
  discovered: { vendorId: number; productId: number },
  plugin: ProfileProvider | undefined,
  model: ModelInfo | undefined,
): PrepProfile {
  if (model?.prepProfile !== undefined) return model.prepProfile
  const vendorProfile = plugin?.preparationProfile?.(discovered, model)
  if (vendorProfile !== undefined) return vendorProfile
  return genericPrepProfile
}
