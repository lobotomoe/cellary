import type { ATResultCode, ParsedLine, ParserContext } from '../types.js'
import { cmeMessage, cmsMessage } from './error-codes.js'

// Regex for CME/CMS error codes: "+CME ERROR: 10" or "+CME ERROR: SIM not inserted"
const CME_REGEX = /^\+CME ERROR:\s*(.+)$/
const CMS_REGEX = /^\+CMS ERROR:\s*(.+)$/

// Final result code strings that are only valid during dial commands (ATD)
const DIAL_ONLY_FINALS = new Set(['NO CARRIER', 'BUSY', 'NO ANSWER', 'NO DIALTONE'])

/**
 * Classify a single line from the modem.
 *
 * Pure function — all state lives in the context parameter.
 * The classification priority is carefully ordered to handle
 * the `NO CARRIER` ambiguity and URC interleaving.
 */
export function parseLine(line: string, context: ParserContext): ParsedLine {
  // 1. Empty line
  if (line === '') {
    return { type: 'empty' }
  }

  // 2. Echo — the modem echoed back our command (echo is on; ATE1)
  if (context.currentCommand !== null && line === context.currentCommand) {
    return { type: 'echo', raw: line }
  }

  // 3. Final result codes — unambiguous ones first
  if (line === 'OK') {
    return { type: 'final_result', result: { type: 'ok' }, raw: line }
  }
  if (line === 'ERROR' || line === 'COMMAND NOT SUPPORT') {
    return { type: 'final_result', result: { type: 'error' }, raw: line }
  }

  // 4. +CME ERROR
  const [, cmeBody] = CME_REGEX.exec(line) ?? []
  if (cmeBody !== undefined) {
    return { type: 'final_result', result: parseCmeError(cmeBody), raw: line }
  }

  // 5. +CMS ERROR
  const [, cmsBody] = CMS_REGEX.exec(line) ?? []
  if (cmsBody !== undefined) {
    return { type: 'final_result', result: parseCmsError(cmsBody), raw: line }
  }

  // 6. Ambiguous final result codes (NO CARRIER, BUSY, etc.)
  //    Only treated as final result during dial commands (ATD*).
  //    Otherwise, they are URCs.
  if (DIAL_ONLY_FINALS.has(line)) {
    const isDial = context.currentCommand?.toUpperCase().startsWith('ATD')

    if (isDial) {
      return {
        type: 'final_result',
        result: dialFinalResult(line),
        raw: line,
      }
    }

    // Not a dial command — treat as URC if known, or info response
    if (context.urcPrefixes.has(line)) {
      return { type: 'urc', prefix: line, body: '', raw: line }
    }
    // Fallback: if idle, treat as URC anyway (it's an async event)
    if (context.currentCommand === null) {
      return { type: 'urc', prefix: line, body: '', raw: line }
    }
  }

  // 7. Known URC — check prefix registry (handles interleaving)
  //    But: if the line's prefix matches the expected response prefix
  //    for the current command, it's an info response, not a URC.
  //    e.g. AT+CREG? expects +CREG: as response, not URC.
  const urc = matchURC(line, context.urcPrefixes)
  if (urc) {
    const expectedPrefix = extractCommandPrefix(context.currentCommand)
    if (expectedPrefix !== null && urc.prefix === expectedPrefix) {
      // This is the command's response, not a URC
      return { type: 'info_response', raw: line }
    }
    return { type: 'urc', ...urc, raw: line }
  }

  // 8. RING is special — always a URC, no colon
  if (line === 'RING') {
    return { type: 'urc', prefix: 'RING', body: '', raw: line }
  }

  // 9. Info response — anything with `+` prefix during a command
  if (context.currentCommand !== null) {
    return { type: 'info_response', raw: line }
  }

  // 10. Unknown line while idle — treat as URC
  const unknownUrc = extractPrefix(line)
  if (unknownUrc) {
    return { type: 'urc', prefix: unknownUrc.prefix, body: unknownUrc.body, raw: line }
  }

  // 11. Truly unknown — treat as info response (best effort)
  return { type: 'info_response', raw: line }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchURC(
  line: string,
  prefixes: ReadonlySet<string>,
): { prefix: string; body: string } | null {
  // Check exact match first (for prefix-only URCs like 'RING', 'NO CARRIER')
  if (prefixes.has(line)) {
    return { prefix: line, body: '' }
  }

  // Check `+PREFIX:` style
  const colonIdx = line.indexOf(':')
  if (colonIdx > 0) {
    const prefix = line.slice(0, colonIdx)
    if (prefixes.has(prefix)) {
      return { prefix, body: line.slice(colonIdx + 1).trimStart() }
    }
  }

  return null
}

/**
 * Extract the expected response prefix from an AT command.
 * AT+CREG? → +CREG, AT+CSQ → +CSQ, AT+CMGS="..." → +CMGS,
 * AT^HCSQ → ^HCSQ, ATD... → null
 */
function extractCommandPrefix(command: string | null): string | null {
  if (command === null) return null
  // Match AT+XXX or AT^XXX (with optional ?, =, or end of string)
  const [, prefix] = /^AT([+^][A-Z]+)/i.exec(command) ?? []
  return prefix?.toUpperCase() ?? null
}

function extractPrefix(line: string): { prefix: string; body: string } | null {
  const colonIdx = line.indexOf(':')
  if (colonIdx > 0) {
    return {
      prefix: line.slice(0, colonIdx),
      body: line.slice(colonIdx + 1).trimStart(),
    }
  }
  return null
}

function parseCmeError(value: string): ATResultCode {
  const code = Number.parseInt(value, 10)
  if (Number.isNaN(code)) {
    // Verbose mode: "+CME ERROR: SIM not inserted"
    return { type: 'cme_error', code: -1, message: value.trim() }
  }
  // Numeric mode: resolve to human-readable message
  const message = cmeMessage(code) ?? `error ${code}`
  return { type: 'cme_error', code, message }
}

function parseCmsError(value: string): ATResultCode {
  const code = Number.parseInt(value, 10)
  if (Number.isNaN(code)) {
    return { type: 'cms_error', code: -1, message: value.trim() }
  }
  const message = cmsMessage(code) ?? `error ${code}`
  return { type: 'cms_error', code, message }
}

function dialFinalResult(line: string): ATResultCode {
  switch (line) {
    case 'NO CARRIER':
      return { type: 'no_carrier' }
    case 'BUSY':
      return { type: 'busy' }
    case 'NO ANSWER':
      return { type: 'no_answer' }
    case 'NO DIALTONE':
      return { type: 'no_dialtone' }
    default:
      return { type: 'error' }
  }
}
