/**
 * Decodes AT command response lines into human-readable descriptions.
 *
 * Input: a single response line like "+COPS: 0,0,\"UCOM\",2"
 * Output: human-readable string or undefined if not recognized.
 */

import { ACCESS_TECH, CPIN_STATES, REG_STATUS } from '../../lib/3gpp-tables.js'

const COPS_MODE: Record<string, string> = {
  '0': 'Auto',
  '1': 'Manual',
  '2': 'Deregister',
  '3': 'Format only',
  '4': 'Manual/Auto',
}

const CLIP_PROVISION: Record<string, string> = {
  '0': 'not provisioned by network',
  '1': 'provisioned',
  '2': 'provision unknown',
}

const CCFC_STATUS: Record<string, string> = {
  '0': 'disabled',
  '1': 'enabled',
}

const CVOICE_MODE: Record<string, string> = {
  '0': 'disabled',
  '1': 'enabled',
}

const CFUN_MODE: Record<string, string> = {
  '0': 'Minimum functionality',
  '1': 'Full functionality',
  '4': 'Airplane mode (RF off)',
}

// ── Decoder functions ────────────────────────────────────────────────────────

type Decoder = (body: string) => string | undefined

const DECODERS: Record<string, Decoder> = {
  // +COPS: <mode>[,<format>,"<oper>"[,<AcT>]]
  '+COPS'(body) {
    const match = /^(\d+)(?:,\d+,"([^"]*)"(?:,(\d+))?)?/.exec(body)
    if (!match) return undefined
    const [, modeStr, oper, actStr] = match
    const parts: string[] = []
    if (modeStr !== undefined) {
      const mode = COPS_MODE[modeStr]
      if (mode !== undefined) parts.push(`${mode} selection`)
    }
    if (oper !== undefined) parts.push(oper)
    if (actStr !== undefined) {
      const tech = ACCESS_TECH[actStr]
      if (tech !== undefined) parts.push(tech)
    }
    return parts.join(', ')
  },

  // +CREG: <n>,<stat>[,"<lac>","<ci>"[,<AcT>]]
  '+CREG'(body) {
    const match = /^\d+,(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?/.exec(body)
    if (!match) return undefined
    const [, stat, lac, cellId, act] = match
    if (stat === undefined) return undefined
    const parts = [REG_STATUS[stat] ?? `Status ${stat}`]
    if (lac !== undefined && lac !== '') parts.push(`LAC ${lac}`)
    if (cellId !== undefined && cellId !== '') parts.push(`Cell ${cellId}`)
    if (act !== undefined) {
      const tech = ACCESS_TECH[act]
      if (tech !== undefined) parts.push(tech)
    }
    return `CS: ${parts.join(', ')}`
  },

  // +CGREG: same format as +CREG
  '+CGREG'(body) {
    const result = DECODERS['+CREG']?.(body)
    if (result === undefined) return undefined
    return result.replace('CS:', 'GPRS:')
  },

  // +CSQ: <rssi>,<ber>
  '+CSQ'(body) {
    const match = /^(\d+),(\d+)/.exec(body)
    if (!match) return undefined
    const [, rssiStr, berStr] = match
    if (rssiStr === undefined || berStr === undefined) return undefined
    const rssi = Number.parseInt(rssiStr, 10)
    const ber = Number.parseInt(berStr, 10)
    if (rssi === 99) return 'Signal: unknown'
    const dbm = -113 + rssi * 2
    const berLabel = ber === 99 ? 'unknown' : `${ber}`
    return `Signal: ${dbm} dBm (CSQ ${rssi}), BER: ${berLabel}`
  },

  // +CLIP: <n>,<m>
  '+CLIP'(body) {
    const match = /^(\d+),(\d+)/.exec(body)
    if (!match) return undefined
    const [, nStr, mStr] = match
    if (nStr === undefined || mStr === undefined) return undefined
    const enabled = nStr === '1' ? 'enabled' : 'disabled'
    const provision = CLIP_PROVISION[mStr] ?? `status ${mStr}`
    return `Caller ID: ${enabled}, ${provision}`
  },

  // +CCFC: <status>,<class>[,<number>,<type>]
  '+CCFC'(body) {
    const match = /^(\d+),(\d+)/.exec(body)
    if (!match) return undefined
    const [, statusStr] = match
    if (statusStr === undefined) return undefined
    const status = CCFC_STATUS[statusStr] ?? `status ${statusStr}`
    return `Call forwarding: ${status}`
  },

  // +CPIN: <code>
  '+CPIN'(body) {
    const trimmed = body.trim()
    return CPIN_STATES[trimmed] ?? `SIM: ${trimmed}`
  },

  // +CFUN: <fun>
  '+CFUN'(body) {
    const match = /^(\d+)/.exec(body)
    if (!match) return undefined
    const [, funStr] = match
    if (funStr === undefined) return undefined
    return CFUN_MODE[funStr] ?? `Mode ${funStr}`
  },

  // +CNUM: [<alpha>],<number>,<type>
  '+CNUM'(body) {
    const match = /(?:^|,)"([^"]+)"/.exec(body)
    if (!match) return undefined
    const [, number] = match
    if (number === undefined) return undefined
    return `Own number: ${number}`
  },

  // ^CVOICE: <mode>,<rate>,<bits>,<frame_ms>
  '^CVOICE'(body) {
    const match = /^(\d+)(?:,\s*(\d+),\s*(\d+),\s*(\d+))?/.exec(body)
    if (!match) return undefined
    const [, modeStr, rate, bits, frame] = match
    if (modeStr === undefined) return undefined
    const mode = CVOICE_MODE[modeStr] ?? `mode ${modeStr}`
    if (rate !== undefined && bits !== undefined && frame !== undefined) {
      return `Voice over USB: ${mode}, PCM ${rate}Hz ${bits}-bit ${frame}ms`
    }
    return `Voice over USB: ${mode}`
  },

  // ^SYSCFGEX: "<acqorder>",<band>,<roam>,<srvdomain>,<lteband>
  '^SYSCFGEX'(body) {
    const match = /^"([^"]*)"/.exec(body)
    if (!match) return undefined
    const [, order] = match
    if (order === undefined) return undefined
    const modes: Record<string, string> = {
      '00': 'Auto',
      '01': 'GSM only',
      '02': '3G only',
      '03': 'LTE only',
      '0201': '3G preferred, GSM fallback',
      '0301': 'LTE preferred, GSM fallback',
      '0302': 'LTE preferred, 3G fallback',
      '030201': 'LTE > 3G > GSM',
      '020301': '3G > LTE > GSM',
      '010302': 'GSM > LTE > 3G',
    }
    return `Network mode: ${modes[order] ?? `order "${order}"`}`
  },

  // ^ICCID: <iccid>
  '^ICCID'(body) {
    return `ICCID: ${body.trim()}`
  },
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a single AT response line.
 *
 * @param line - A response line like "+COPS: 0,0,\"UCOM\",7"
 * @returns Human-readable description, or undefined if not recognized
 */
export function decodeResponse(line: string): string | undefined {
  // Match prefix: body pattern (e.g. "+COPS: 0,0,"UCOM",7" or "^CVOICE: 1, 8000, 16, 20")
  const match = /^([+^][A-Z]+):\s*(.*)$/.exec(line)
  if (!match) return undefined
  const [, prefix, body] = match
  if (prefix === undefined || body === undefined) return undefined

  const decoder = DECODERS[prefix]
  if (decoder === undefined) return undefined

  return decoder(body)
}
