import type { UnsolicitedMessage, VendorPlugin } from 'cellary'

import { ACCESS_TECH, CPIN_STATES, REG_STATUS } from '../../lib/3gpp-tables.js'

// ── Decoder ──────────────────────────────────────────────────────────────────

/** Parse a registration message body: <stat>[,"<lac>","<ci>"[,<AcT>]] */
function decodeRegistration(body: string, domain: string): string | undefined {
  const match = /^(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?$/.exec(body)
  if (!match) return undefined

  const [, stat, lac, cellId, act] = match
  if (stat === undefined) return undefined

  const status = REG_STATUS[stat] ?? `Status ${stat}`
  const parts = [status]

  if (lac !== undefined && lac !== '') {
    parts.push(`LAC ${lac}`)
  }
  if (cellId !== undefined && cellId !== '') {
    parts.push(`Cell ${cellId}`)
  }
  if (act !== undefined) {
    const tech = ACCESS_TECH[act]
    if (tech !== undefined) {
      parts.push(tech)
    }
  }

  return `${domain}: ${parts.join(', ')}`
}

/**
 * Decode an unsolicited message into a human-readable description.
 * Handles standard 3GPP messages directly; delegates vendor messages to the active plugin.
 * Returns undefined if the message is not recognised.
 */
export function decodeMessage(msg: UnsolicitedMessage, vendor?: VendorPlugin): string | undefined {
  const { prefix, body } = msg

  // ── 3GPP Registration ────────────────────────────────────────────────

  if (prefix === '+CREG') {
    return decodeRegistration(body, 'CS network')
  }

  if (prefix === '+CGREG') {
    return decodeRegistration(body, 'GPRS network')
  }

  if (prefix === '+CEREG') {
    return decodeRegistration(body, 'LTE network')
  }

  // ── SIM state ────────────────────────────────────────────────────────

  if (prefix === '+CPIN') {
    const state = CPIN_STATES[body.trim()]
    if (state !== undefined) return `SIM: ${state}`
    return `SIM: ${body.trim()}`
  }

  // ── Call-related ─────────────────────────────────────────────────────

  if (prefix === 'BUSY') {
    return 'Remote party busy'
  }

  if (prefix === 'NO ANSWER') {
    return 'No answer'
  }

  if (prefix === 'NO DIALTONE') {
    return 'No dial tone'
  }

  // ── USSD ─────────────────────────────────────────────────────────────

  if (prefix === '+CUSD') {
    // +CUSD: <m>[,"<str>",<dcs>]
    const match = /^(\d+)(?:,"([^"]*)")?/.exec(body)
    if (!match) return undefined
    const [, mode, text] = match
    const USSD_MODE: Record<string, string> = {
      '0': 'No further action',
      '1': 'Action needed',
      '2': 'Terminated',
    }
    const modeDesc = mode !== undefined ? USSD_MODE[mode] : undefined

    if (text !== undefined && text !== '') {
      const modeLabel = modeDesc !== undefined ? ` (${modeDesc})` : ''
      return `USSD response${modeLabel}: ${text}`
    }
    if (modeDesc !== undefined) return `USSD: ${modeDesc}`
    return undefined
  }

  // ── Vendor-specific ──────────────────────────────────────────────────

  return vendor?.decodeMessage?.(msg)
}
