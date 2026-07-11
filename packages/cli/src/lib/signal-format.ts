/**
 * Signal strength formatting helpers shared across CLI commands.
 *
 * Uses ascending block characters for a phone-style signal indicator:
 * ▁▃▅▇█ (5 bars, ascending height — tallest = strongest)
 */

import type { SignalInfo } from 'cellary'

// Ascending bar characters — each taller than the previous
const BAR_CHARS = ['\u2581', '\u2583', '\u2585', '\u2587', '\u2588'] as const // ▁▃▅▇█
const BAR_EMPTY = '\u2591' // ░
const BAR_COUNT = BAR_CHARS.length

// Thresholds in dBm — descending. First match determines level.
const THRESHOLDS = [-51, -73, -85, -95, -105] as const

/** Signal level 0-5 from RSSI in dBm. Returns 0 when RSSI is unknown. */
export function signalLevel(rssiDbm: number | undefined): number {
  if (rssiDbm === undefined) return 0
  for (let i = 0; i < THRESHOLDS.length; i++) {
    const threshold = THRESHOLDS[i]
    if (threshold !== undefined && rssiDbm >= threshold) {
      return BAR_COUNT - i
    }
  }
  return 0
}

/**
 * Plain-text ascending signal bars: "▁▃▅░░" (3 of 5).
 * Used in non-color contexts (e.g. `cellary signal` one-shot command).
 * Returns all-empty bars when RSSI is unknown.
 */
export function signalBars(rssiDbm: number | undefined): string {
  const level = signalLevel(rssiDbm)
  const active = BAR_CHARS.slice(0, level).join('')
  const inactive = BAR_EMPTY.repeat(BAR_COUNT - level)
  return active + inactive
}

/** Returns the Ink color name for the signal level. */
export function signalColor(rssiDbm: number | undefined): 'green' | 'yellow' | 'red' {
  if (rssiDbm === undefined) return 'red'
  if (rssiDbm >= -75) return 'green'
  if (rssiDbm >= -85) return 'yellow'
  return 'red'
}

/** Active and inactive bar strings for colored rendering in Ink. */
export function signalBarParts(rssiDbm: number | undefined): { active: string; inactive: string } {
  const level = signalLevel(rssiDbm)
  return {
    active: BAR_CHARS.slice(0, level).join(''),
    inactive: BAR_EMPTY.repeat(BAR_COUNT - level),
  }
}

/** Placeholder shown when no signal data is available yet. */
export const SIGNAL_EMPTY = BAR_EMPTY.repeat(BAR_COUNT)

// ── Registration status ─────────────────────────────────────────────────────

/** Ink color for network registration status dot. */
export function registrationColor(status: string): 'green' | 'yellow' | 'red' {
  switch (status) {
    case 'home':
      return 'green'
    case 'roaming':
    case 'searching':
      return 'yellow'
    default:
      return 'red'
  }
}

// ── Human-readable signal interpretation ────────────────────────────────────

// RSRP thresholds (LTE, more accurate when available)
const RSRP_EXCELLENT = -80
const RSRP_GOOD = -90
const RSRP_FAIR = -100
const RSRP_WEAK = -110

// RSSI thresholds (fallback for 2G/3G)
const RSSI_EXCELLENT = -65
const RSSI_GOOD = -75
const RSSI_FAIR = -85
const RSSI_WEAK = -95

/**
 * Human-readable signal quality label.
 * Uses RSRP when available (LTE), falls back to RSSI.
 */
export function signalQualityLabel(rssiDbm: number | undefined, rsrp?: number): string {
  if (rsrp !== undefined) {
    if (rsrp >= RSRP_EXCELLENT) return 'Excellent signal'
    if (rsrp >= RSRP_GOOD) return 'Good signal'
    if (rsrp >= RSRP_FAIR) return 'Fair signal'
    if (rsrp >= RSRP_WEAK) return 'Weak signal'
    return 'Very weak signal'
  }
  if (rssiDbm === undefined) return 'No signal'
  if (rssiDbm >= RSSI_EXCELLENT) return 'Excellent signal'
  if (rssiDbm >= RSSI_GOOD) return 'Good signal'
  if (rssiDbm >= RSSI_FAIR) return 'Fair signal'
  if (rssiDbm >= RSSI_WEAK) return 'Weak signal'
  return 'Very weak signal'
}

// SINR thresholds (LTE connection quality)
const SINR_EXCELLENT = 20
const SINR_GOOD = 10
const SINR_FAIR = 0

/**
 * Human-readable connection quality from SINR.
 * Returns undefined when SINR is not available (non-LTE).
 */
export function connectionQualityLabel(sinr: number | undefined): string | undefined {
  if (sinr === undefined) return undefined
  if (sinr >= SINR_EXCELLENT) return 'Clean connection'
  if (sinr >= SINR_GOOD) return 'Stable connection'
  if (sinr >= SINR_FAIR) return 'Noisy connection'
  return 'Very noisy'
}

// ── Signal main-line formatting ──────────────────────────────────────────────

/**
 * Format the signal main line: "rssi dBm  LTE  Band B7  BER: 0"
 * Technology comes from registration when available, falls back to signal.
 * BER is only shown when no LTE metrics are present (BER=99 on HTTP APIs is noise).
 */
export function formatSignalMainLine(signal: SignalInfo, technology?: string): string {
  const rssiLabel = signal.rssi !== undefined ? `${signal.rssi} dBm` : 'N/A'
  const parts = [rssiLabel]
  if (technology !== undefined) parts.push(technology)
  if (signal.band !== undefined) parts.push(`Band ${signal.band}`)

  const hasLte = signal.rsrp !== undefined || signal.rsrq !== undefined || signal.sinr !== undefined
  if (!hasLte && signal.bitErrorRate !== 99) parts.push(`BER: ${signal.bitErrorRate}`)

  return parts.join('  ')
}

// ── LTE signal detail formatting ────────────────────────────────────────────

/** Format LTE signal detail line. Returns undefined when no LTE metrics present. */
export function formatSignalDetails(signal: SignalInfo): string | undefined {
  const parts: string[] = []
  if (signal.rsrp !== undefined) parts.push(`RSRP: ${signal.rsrp}`)
  if (signal.rsrq !== undefined) parts.push(`RSRQ: ${signal.rsrq}`)
  if (signal.sinr !== undefined) parts.push(`SINR: ${signal.sinr}`)
  return parts.length > 0 ? parts.join('  ') : undefined
}

// ── Signal sparkline (history visualization) ────────────────────────────────

// 8 levels of block height for smooth sparkline rendering
const SPARK_CHARS = [
  '\u2581', // ▁ lowest
  '\u2582', // ▂
  '\u2583', // ▃
  '\u2584', // ▄
  '\u2585', // ▅
  '\u2586', // ▆
  '\u2587', // ▇
  '\u2588', // █ highest
] as const

const SPARK_LEVELS = SPARK_CHARS.length

// RSSI range for sparkline mapping
const SPARK_MIN_RSSI = -110 // worst signal
const SPARK_MAX_RSSI = -50 // best signal
const SPARK_RSSI_RANGE = SPARK_MAX_RSSI - SPARK_MIN_RSSI

/**
 * Convert an RSSI value to a sparkline character.
 * Maps -110 dBm (worst) to ▁ and -50 dBm (best) to █.
 */
export function sparkChar(rssiDbm: number): string {
  const clamped = Math.max(SPARK_MIN_RSSI, Math.min(SPARK_MAX_RSSI, rssiDbm))
  const normalized = (clamped - SPARK_MIN_RSSI) / SPARK_RSSI_RANGE
  const index = Math.min(SPARK_LEVELS - 1, Math.floor(normalized * SPARK_LEVELS))
  return SPARK_CHARS[index] ?? SPARK_CHARS[0] ?? ''
}

/** Render an array of RSSI values as a sparkline string. */
export function signalSparkline(history: readonly number[]): string {
  return history.map(sparkChar).join('')
}
