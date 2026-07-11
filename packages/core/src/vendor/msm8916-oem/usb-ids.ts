/**
 * USB identifiers for Qualcomm-based MiFi/UFI 4G dongles.
 *
 * These devices run Android internally and expose RNDIS over USB.
 * Management is via HTTP API at 192.168.100.1 (POST /ajax).
 */

/** Qualcomm USB vendor ID */
export const QUALCOMM_VID = 0x05c6

/** Known USB product IDs for MiFi dongles */
export const MIFI_PIDS = {
  /** Default RNDIS-only composition (most common) */
  rndis: 0xf00e,
  /** Qualcomm Emergency Download mode (device failed to boot) */
  edl: 0x9008,
} as const

/** Default management API address */
export const MIFI_DEFAULT_HOST = '192.168.100.1'

/** Default login credentials (most devices ship with these) */
export const MIFI_DEFAULT_CREDENTIALS = {
  username: 'admin',
  password: 'admin',
} as const
