/**
 * Huawei vendor URC decoder.
 *
 * Decodes Huawei-proprietary URCs into human-readable strings.
 * Also exports the URC prefix constants for use in vendor-aware consumers
 * (e.g. call state machines that need to react to ^ORIG / ^CONN / ^CEND).
 */

import type { URC } from '../../protocols/at/types.js'

// ── URC prefix constants ──────────────────────────────────────────────────────

export const HUAWEI_URC_RSSI = '^RSSI'
export const HUAWEI_URC_HCSQ = '^HCSQ'
export const HUAWEI_URC_MODE = '^MODE'
export const HUAWEI_URC_SIMST = '^SIMST'
export const HUAWEI_URC_SRVST = '^SRVST'
export const HUAWEI_URC_BOOT = '^BOOT'
export const HUAWEI_URC_CEND = '^CEND'
export const HUAWEI_URC_ORIG = '^ORIG'
export const HUAWEI_URC_CONF = '^CONF'
export const HUAWEI_URC_CONN = '^CONN'
export const HUAWEI_URC_DSFLOWRPT = '^DSFLOWRPT'

// ── Internal lookup tables ────────────────────────────────────────────────────

// ^MODE sys_mode values (Huawei AT spec)
const SYS_MODE: Record<string, string> = {
  '0': 'No service',
  '1': 'GSM',
  '2': 'GPRS',
  '3': '3G (WCDMA)',
  '4': '3G HSDPA',
  '5': '3G HSUPA',
  '6': '3G HSPA+',
  '7': 'LTE',
  '17': 'LTE+',
}

// ^SIMST sim_state values (Huawei AT spec)
const SIM_STATE: Record<string, string> = {
  '0': 'Invalid / no SIM',
  '1': 'SIM ready',
  '2': 'SIM PIN required',
  '3': 'SIM PUK required',
  '4': 'SIM PIN2 required',
  '5': 'SIM PUK2 required',
  '240': 'SIM init in progress',
  '255': 'SIM removed',
}

// ^SRVST srv_state values (Huawei AT spec)
const SRV_STATE: Record<string, string> = {
  '0': 'No service',
  '1': 'Limited service',
  '2': 'Full service',
  '3': 'Limited regional service',
  '4': 'Power saving / deep sleep',
}

// ── Decoder ───────────────────────────────────────────────────────────────────

/**
 * Decode a Huawei vendor URC into a human-readable string.
 * Returns undefined if the URC is not a known Huawei URC.
 */
export function decodeHuaweiURC(urc: URC): string | undefined {
  const { prefix, body } = urc

  if (prefix === HUAWEI_URC_RSSI) {
    // ^RSSI: <value> (0-31 CSQ scale)
    const csq = Number.parseInt(body.trim(), 10)
    if (Number.isNaN(csq)) return undefined
    if (csq === 99) return 'Signal: unknown'
    const dbm = -113 + csq * 2
    return `Signal: ${dbm} dBm (CSQ ${csq})`
  }

  if (prefix === HUAWEI_URC_HCSQ) {
    // ^HCSQ: "LTE",<rssi>,<rsrp>,<sinr>,<rsrq>
    const match = /^"([^"]*)"/.exec(body)
    if (!match) return undefined
    const [, tech] = match
    if (tech !== undefined) return `Signal quality: ${tech} mode`
    return undefined
  }

  if (prefix === HUAWEI_URC_MODE) {
    // ^MODE: <sys_mode>,<sub_mode>
    const match = /^(\d+)/.exec(body)
    if (!match) return undefined
    const [, sysMode] = match
    if (sysMode === undefined) return undefined
    const mode = SYS_MODE[sysMode] ?? `Mode ${sysMode}`
    return `Network mode: ${mode}`
  }

  if (prefix === HUAWEI_URC_SIMST) {
    const state = SIM_STATE[body.trim()]
    if (state !== undefined) return `SIM: ${state}`
    return undefined
  }

  if (prefix === HUAWEI_URC_SRVST) {
    const state = SRV_STATE[body.trim()]
    if (state !== undefined) return `Service: ${state}`
    return undefined
  }

  if (prefix === HUAWEI_URC_BOOT) {
    return 'Device booted'
  }

  if (prefix === HUAWEI_URC_CEND) {
    // ^CEND: <call_x>,<duration>,<end_status>[,<cc_cause>]
    const match = /^\d+,(\d+),(\d+)(?:,(\d+))?/.exec(body)
    if (!match) return undefined
    const [, durStr, , causeStr] = match
    const dur = durStr !== undefined ? Number.parseInt(durStr, 10) : 0
    const durLabel = dur > 0 ? ` after ${dur}s` : ''
    const causeLabel = causeStr !== undefined ? ` (cause: ${causeStr})` : ''
    return `Call ended${durLabel}${causeLabel}`
  }

  if (prefix === HUAWEI_URC_ORIG) {
    return 'Call setup started (modem -> network)'
  }

  if (prefix === HUAWEI_URC_CONF) {
    return 'Network confirmed -- remote phone is ringing'
  }

  if (prefix === HUAWEI_URC_CONN) {
    return 'Call connected -- remote party answered'
  }

  if (prefix === HUAWEI_URC_DSFLOWRPT) {
    return 'Data flow report (suppressed)'
  }

  return undefined
}
