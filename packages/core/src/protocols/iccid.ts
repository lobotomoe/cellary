/**
 * ICCID normalization, shared by every SIM reader (AT, HiLink, JRD).
 *
 * Lives outside protocols/services so those modules stay pure interface
 * declarations with no runtime imports.
 */

import { ParseError } from '../errors.js'

/**
 * Normalize an ICCID by stripping trailing padding.
 *
 * ICCIDs are decimal digits (up to 20, ITU-T E.118). Devices pad short values
 * with a non-digit filler -- standard 'F' (the 0xF BCD nibble), but some
 * firmware uses other characters (e.g. Alcatel JRD pads with 'p'). Strip any
 * trailing run of non-digits.
 */
export function normalizeIccid(raw: string): string {
  const stripped = raw.replace(/\D+$/, '')

  if (stripped.length === 0) {
    throw new ParseError('ICCID contains only padding bytes (no valid digits)', raw)
  }

  return stripped
}
