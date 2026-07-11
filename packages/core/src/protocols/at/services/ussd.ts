import { ParseError } from '../../../errors.js'
import type { Ussd } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig, URC } from '../types.js'

const RESPONSE_TIMEOUT_MS = 30_000

// +CUSD: <n>,"<str>"[,<dcs>]
// Captures: [1] = response text, [2] = DCS (optional)
const CUSD_REGEX = /\+CUSD:\s*\d+,"([^"]*)"(?:,(\d+))?/

const DCS_UCS2 = 72

/** Decode a UCS2 hex string (UTF-16BE) to a JS string. */
function decodeUcs2Hex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  const view = new DataView(bytes.buffer)
  const chars: string[] = []
  for (let i = 0; i < bytes.length; i += 2) {
    chars.push(String.fromCharCode(view.getUint16(i)))
  }
  return chars.join('')
}

/** Decode USSD response text based on DCS (Data Coding Scheme). */
function decodeUssdResponse(text: string, dcsStr: string | undefined): string {
  if (dcsStr === undefined) return text
  const dcs = Number.parseInt(dcsStr, 10)
  if (dcs === DCS_UCS2 && /^[0-9A-Fa-f]+$/.test(text) && text.length % 4 === 0) {
    return decodeUcs2Hex(text)
  }
  return text
}

/** USSD interactive session support */
export class UssdModule implements Ussd {
  private readonly channel: ATChannel

  constructor(channel: ATChannel, _profile: AtConfig) {
    this.channel = channel
  }

  /**
   * Send a USSD request and wait for the response text.
   *
   * Handles both delivery modes:
   * - Synchronous: modem includes +CUSD: before OK (rare, handled via result.lines)
   * - Asynchronous: modem sends OK immediately, then +CUSD: as a URC (common)
   *
   * onURC('+CUSD') auto-adds +CUSD to the channel's URC prefix set, so the
   * channel correctly routes the response line to our handler in both cases.
   *
   * Response decoding: DCS=72 indicates UCS2 (UTF-16BE hex). The modem returns
   * hex-encoded Unicode which we decode to a readable JS string.
   */
  async send(code: string): Promise<string> {
    let resolveUrc: (text: string) => void
    const urcArrived = new Promise<string>((resolve) => {
      resolveUrc = resolve
    })

    const unsubscribe = this.channel.onURC('+CUSD', (urc: URC) => {
      const [, text, dcs] = CUSD_REGEX.exec(urc.raw) ?? []
      resolveUrc(text !== undefined ? decodeUssdResponse(text, dcs) : urc.body)
    })

    try {
      const result = await this.channel.execute(`AT+CUSD=1,"${code}",15`, {
        timeout: RESPONSE_TIMEOUT_MS,
      })

      // Some modems include +CUSD: before OK — check result.lines first
      const syncLine = result.lines.find((l) => l.startsWith('+CUSD:'))
      if (syncLine !== undefined) {
        const [, text, dcs] = CUSD_REGEX.exec(syncLine) ?? []
        if (text === undefined) {
          throw new ParseError('USSD response present but unparseable', syncLine)
        }
        return decodeUssdResponse(text, dcs)
      }

      // Most modems send +CUSD: as a URC after OK — wait for it
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('USSD response timed out')), RESPONSE_TIMEOUT_MS),
      )
      return await Promise.race([urcArrived, timeout])
    } finally {
      unsubscribe()
    }
  }

  /** Cancel an ongoing USSD session (best-effort, errors swallowed) */
  async cancel(): Promise<void> {
    try {
      await this.channel.execute('AT+CUSD=2')
    } catch {
      // Best-effort cancel — session may already be closed
    }
  }
}
