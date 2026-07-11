/**
 * Huawei HiLink HTTP API.
 *
 * Re-exports from domain-specific modules:
 * - session.ts  -- session tokens, authentication, password hashing
 * - http.ts     -- low-level GET/POST with timeout and CSRF rotation
 * - mode-switch.ts -- HiLink -> AT mode transition
 *
 * See README.md for the full endpoint reference and protocol documentation.
 */

import type { ModemDriver } from '../../../../types.js'

/**
 * Driver identifier for the HiLink HTTP API.
 * Registered in the USB database so the generic discovery layer
 * never needs to reference the 'hilink' string directly.
 */
export const HILINK_DRIVER: ModemDriver = { kind: 'vendor', api: 'hilink' }

// ── Error codes ──────────────────────────────────────────────────────────────

/** Error code for HiLink endpoints that are blocked by the firmware. */
export const HILINK_ERR_MODE_NOT_SUPPORTED = '125002'

/**
 * Error code for HiLink login lockout.
 * RAM-based: resets when the device loses power (USB unplug or hardware reset).
 */
export const HILINK_ERR_ACCOUNT_LOCKED = '108006'

// ── Re-exports ───────────────────────────────────────────────────────────────

export { requestHiLinkModeSwitch } from './mode-switch.js'
export { fetchHiLinkSession, hashHiLinkPassword, loginHiLink } from './session.js'
export type { HiLinkCredentials, HiLinkSession } from './types.js'
export { hilinkErrorMessage } from './xml.js'
