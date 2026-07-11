/**
 * GPRS Timer and eDRX cycle encoding/decoding.
 *
 * Translates between AT wire format (binary strings per 3GPP TS 24.008)
 * and domain-level seconds values. Internal to the AT protocol layer.
 */

import { ParseError } from '../../../errors.js'
import type { EDrxAccessType } from '../../../types.js'

// ── GPRS Timer (3GPP TS 24.008 Table 10.5.172) ─────────────────────────────
// Used for: T3312 (Periodic-RAU), T3314 (GPRS-READY), T3324 (Active-Time)
// Format: 8-bit binary string. Bits 8-6 = unit, bits 5-1 = value (0-31).

/** Unit multipliers in seconds: 000=2s, 001=1min, 010=6min, 111=deactivated */
const GPRS_TIMER_UNITS: readonly [number, number][] = [
  [0, 2],
  [1, 60],
  [2, 360],
]

/** Decode GPRS Timer binary string to seconds. Returns undefined if deactivated. */
export function decodeGprsTimer(binary: string): number | undefined {
  if (binary.length !== 8) return undefined
  const byte = Number.parseInt(binary, 2)
  const unitBits = (byte >> 5) & 0x07
  if (unitBits === 7) return undefined // deactivated
  const entry = GPRS_TIMER_UNITS.find(([bits]) => bits === unitBits)
  if (entry === undefined) return undefined // reserved unit codes (3-6)
  const [, unitSeconds] = entry
  const value = byte & 0x1f
  return value * unitSeconds
}

/** Encode seconds to GPRS Timer 8-bit binary string. */
export function encodeGprsTimer(seconds: number): string {
  // Try each unit, prefer exact representation
  for (const [unitBits, unitSec] of GPRS_TIMER_UNITS) {
    if (seconds % unitSec === 0) {
      const value = seconds / unitSec
      if (value >= 0 && value <= 31) {
        return ((unitBits << 5) | value).toString(2).padStart(8, '0')
      }
    }
  }
  // Fall back to nearest fit with the smallest viable unit
  for (const [unitBits, unitSec] of GPRS_TIMER_UNITS) {
    const value = Math.round(seconds / unitSec)
    if (value >= 0 && value <= 31) {
      return ((unitBits << 5) | value).toString(2).padStart(8, '0')
    }
  }
  throw new ParseError(`Cannot encode ${seconds}s as GPRS Timer`, String(seconds))
}

// ── GPRS Timer 3 (3GPP TS 24.008 Table 10.5.163a) ──────────────────────────
// Used for: T3412 extended (Periodic-TAU)
// Same 8-bit format but different unit multipliers.

/** Timer 3 units, ordered smallest-first for encoding preference */
const GPRS_TIMER3_UNITS: readonly [number, number][] = [
  [3, 2], // 011 = 2 seconds
  [4, 30], // 100 = 30 seconds
  [5, 60], // 101 = 1 minute
  [0, 600], // 000 = 10 minutes
  [1, 3600], // 001 = 1 hour
  [2, 36_000], // 010 = 10 hours
  [6, 1_152_000], // 110 = 320 hours
]

/** Decode GPRS Timer 3 binary string to seconds. Returns undefined if deactivated. */
export function decodeGprsTimer3(binary: string): number | undefined {
  if (binary.length !== 8) return undefined
  const byte = Number.parseInt(binary, 2)
  const unitBits = (byte >> 5) & 0x07
  if (unitBits === 7) return undefined // deactivated
  const entry = GPRS_TIMER3_UNITS.find(([bits]) => bits === unitBits)
  if (entry === undefined) return undefined
  const [, unitSeconds] = entry
  const value = byte & 0x1f
  return value * unitSeconds
}

/** Encode seconds to GPRS Timer 3 8-bit binary string. */
export function encodeGprsTimer3(seconds: number): string {
  // Prefer largest unit for cleaner encoding (3 * 10h over 30 * 1h)
  for (let i = GPRS_TIMER3_UNITS.length - 1; i >= 0; i--) {
    const entry = GPRS_TIMER3_UNITS[i]
    if (entry === undefined) continue
    const [unitBits, unitSec] = entry
    if (seconds % unitSec === 0) {
      const value = seconds / unitSec
      if (value >= 0 && value <= 31) {
        return ((unitBits << 5) | value).toString(2).padStart(8, '0')
      }
    }
  }
  // Fall back: nearest approximation with the largest feasible unit
  for (let i = GPRS_TIMER3_UNITS.length - 1; i >= 0; i--) {
    const entry = GPRS_TIMER3_UNITS[i]
    if (entry === undefined) continue
    const [unitBits, unitSec] = entry
    const value = Math.round(seconds / unitSec)
    if (value >= 0 && value <= 31) {
      return ((unitBits << 5) | value).toString(2).padStart(8, '0')
    }
  }
  throw new ParseError(`Cannot encode ${seconds}s as GPRS Timer 3`, String(seconds))
}

// ── eDRX Cycle Duration (3GPP TS 24.008 Table 10.5.5.32) ───────────────────

/** E-UTRAN WB (LTE Cat-M) eDRX cycle durations in seconds per binary code */
const EUTRAN_WB_EDRX: Record<number, number> = {
  0: 5.12,
  1: 10.24,
  2: 20.48,
  3: 40.96,
  4: 61.44,
  5: 81.92,
  6: 102.4,
  7: 122.88,
  8: 143.36,
  9: 163.84,
  10: 327.68,
  11: 655.36,
  12: 1310.72,
  13: 2621.44,
}

/** E-UTRAN NB (NB-IoT) eDRX cycle durations (extends WB table) */
const EUTRAN_NB_EDRX: Record<number, number> = {
  ...EUTRAN_WB_EDRX,
  14: 5242.88,
  15: 10485.76,
}

/** UTRAN (3G) eDRX cycle durations */
const UTRAN_EDRX: Record<number, number> = {
  1: 2.56,
  2: 5.12,
  3: 10.24,
  4: 20.48,
  5: 40.96,
  6: 81.92,
  7: 163.84,
  8: 327.68,
  9: 655.36,
  10: 1310.72,
}

/** GSM / EC-GSM-IoT eDRX cycle durations */
const GSM_EDRX: Record<number, number> = {
  0: 1.88,
  1: 3.76,
  2: 7.52,
  3: 11.28,
  4: 22.56,
  5: 33.84,
}

// ── eDRX Paging Time Window (3GPP TS 24.008 Table 10.5.5.32) ───────────────

const EUTRAN_WB_PTW: Record<number, number> = {
  0: 1.28,
  1: 2.56,
  2: 3.84,
  3: 5.12,
  4: 6.4,
  5: 7.68,
  6: 8.96,
  7: 10.24,
  8: 11.52,
  9: 12.8,
  10: 14.08,
  11: 15.36,
}

const EUTRAN_NB_PTW: Record<number, number> = {
  0: 2.56,
  1: 5.12,
  2: 7.68,
  3: 10.24,
  4: 12.8,
  5: 15.36,
  6: 17.92,
  7: 20.48,
  8: 23.04,
  9: 25.6,
  10: 28.16,
  11: 30.72,
  12: 33.28,
  13: 35.84,
  14: 38.4,
  15: 40.96,
}

// ── Lookup helpers ──────────────────────────────────────────────────────────

const EDRX_CYCLE_TABLES: Record<EDrxAccessType, Record<number, number> | undefined> = {
  none: undefined,
  ecGsmIot: GSM_EDRX,
  gsm: GSM_EDRX,
  utran: UTRAN_EDRX,
  eutranWb: EUTRAN_WB_EDRX,
  eutranNb: EUTRAN_NB_EDRX,
}

function cycleTable(accessType: EDrxAccessType): Record<number, number> | undefined {
  return EDRX_CYCLE_TABLES[accessType]
}

const EDRX_PTW_TABLES: Record<EDrxAccessType, Record<number, number> | undefined> = {
  none: undefined,
  ecGsmIot: undefined,
  gsm: undefined,
  utran: undefined,
  eutranWb: EUTRAN_WB_PTW,
  eutranNb: EUTRAN_NB_PTW,
}

function ptwTable(accessType: EDrxAccessType): Record<number, number> | undefined {
  return EDRX_PTW_TABLES[accessType]
}

/** Decode eDRX binary code to cycle duration in seconds. */
export function decodeEdrxCycle(binary: string, accessType: EDrxAccessType): number | undefined {
  const table = cycleTable(accessType)
  if (table === undefined) return undefined
  const code = Number.parseInt(binary, 2)
  return table[code]
}

/** Decode paging time window binary code to seconds. */
export function decodePagingWindow(binary: string, accessType: EDrxAccessType): number | undefined {
  const table = ptwTable(accessType)
  if (table === undefined) return undefined
  const code = Number.parseInt(binary, 2)
  return table[code]
}

/** Encode cycle duration in seconds to eDRX 4-bit binary code (finds nearest match). */
export function encodeEdrxCycle(seconds: number, accessType: EDrxAccessType): string {
  const table = cycleTable(accessType)
  if (table === undefined) {
    throw new ParseError(`eDRX not supported for '${accessType}'`, String(seconds))
  }

  let bestCode = -1
  let bestDiff = Infinity
  for (const [codeStr, cycleSec] of Object.entries(table)) {
    const diff = Math.abs(cycleSec - seconds)
    if (diff < bestDiff) {
      bestDiff = diff
      bestCode = Number(codeStr)
    }
  }

  if (bestCode < 0) {
    throw new ParseError(`No valid eDRX cycle for '${accessType}'`, String(seconds))
  }

  return bestCode.toString(2).padStart(4, '0')
}
