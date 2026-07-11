import { ParseError } from '../../../../errors.js'
import type { SmsCount, SmsMessage } from '../../../../types.js'
import type { Sms } from '../../../adapter.js'
import type { ATChannel } from '../../channel/at-channel.js'
import { isGsm7BitCompatible } from '../../gsm7.js'
import type { AtConfig } from '../../types.js'
import { encodePduSubmit } from './pdu.js'
import { type ConcatInfo, type DecodedPdu, decodePduDeliver } from './pdu-decode.js'

// ─── PDU mode status codes (3GPP TS 27.005 section 3.1) ────────────────────

/** AT+CMGL numeric status filters for PDU mode */
const PDU_LIST_STATUS: Record<string, number> = {
  unread: 0,
  read: 1,
  unsent: 2,
  sent: 3,
  all: 4,
}

/** PDU mode status code -> domain status */
const PDU_STATUS_MAP: Record<number, SmsMessage['status']> = {
  0: 'unread',
  1: 'read',
  2: 'unsent',
  3: 'sent',
}

// +CMGL: <index>,<stat>,<alpha>,<length>  (PDU mode)
const CMGL_PDU_REGEX = /^\+CMGL:\s*(\d+),(\d+),[^,]*,(\d+)$/

// +CMGR: <stat>,<alpha>,<length>  (PDU mode)
const CMGR_PDU_REGEX = /^\+CMGR:\s*(\d+),[^,]*,(\d+)$/

// +CPMS: "ME",<used>,<total>,"ME",<used>,<total>,"ME",<used>,<total>
const CPMS_REGEX = /\+CPMS:\s*"[^"]*",(\d+),(\d+)/

/** Intermediate: decoded segment with modem index and status */
interface DecodedSegment {
  readonly index: number
  readonly status: SmsMessage['status']
  readonly pdu: DecodedPdu
}

/** SMS send, receive, read, delete */
export class SmsModule implements Sms {
  private readonly channel: ATChannel

  constructor(channel: ATChannel, _profile: AtConfig) {
    this.channel = channel
  }

  /**
   * Send an SMS message with adaptive encoding.
   *
   * GSM 7-bit compatible text (ASCII, basic Latin) uses text mode (AT+CMGF=1).
   * Unicode text (Cyrillic, Armenian, emoji, etc.) uses PDU mode (AT+CMGF=0)
   * with UCS-2 encoding per 3GPP TS 23.040.
   */
  async send(to: string, text: string): Promise<number> {
    if (isGsm7BitCompatible(text)) {
      return this.sendTextMode(to, text)
    }
    return this.sendPduMode(to, text)
  }

  /** Send via text mode (AT+CMGF=1) -- for GSM 7-bit compatible text */
  private async sendTextMode(to: string, text: string): Promise<number> {
    await this.channel.execute('AT+CMGF=1')

    const result = await this.channel.execute(`AT+CMGS="${to}"`, {
      expectsPrompt: true,
      promptData: text,
      timeout: 30_000,
    })

    return this.parseMessageReference(result.lines)
  }

  /**
   * Send via PDU mode (AT+CMGF=0) -- for UCS-2 unicode text.
   *
   * Long messages are automatically split into concatenated segments
   * with UDH headers per 3GPP TS 23.040 section 9.2.3.24.1.
   * Returns the message reference of the first segment.
   */
  private async sendPduMode(to: string, text: string): Promise<number> {
    // Encode all PDUs before sending any AT commands -- fail fast on invalid input
    const segments = encodePduSubmit(to, text)

    await this.channel.execute('AT+CMGF=0')

    let firstRef: number | undefined

    for (const segment of segments) {
      const result = await this.channel.execute(`AT+CMGS=${segment.length}`, {
        expectsPrompt: true,
        promptData: segment.pdu,
        timeout: 30_000,
      })

      const ref = this.parseMessageReference(result.lines)
      if (firstRef === undefined) {
        firstRef = ref
      }
    }

    if (firstRef === undefined) {
      throw new ParseError('AT+CMGS: no segments were sent', '')
    }

    return firstRef
  }

  /** Parse +CMGS: <mr> message reference from response */
  private parseMessageReference(lines: readonly string[]): number {
    const line = lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CMGS: no response line after send', lines.join('\n'))
    }
    const [, ref] = /\+CMGS:\s*(\d+)/.exec(line) ?? []
    if (ref === undefined) {
      throw new ParseError('AT+CMGS: failed to parse message reference', line)
    }
    return Number.parseInt(ref, 10)
  }

  /**
   * List SMS messages by status.
   *
   * Uses PDU mode to access full message data including UDH concatenation
   * headers. Multipart messages are automatically reassembled into single
   * messages with joined text.
   */
  async list(status: 'all' | 'unread' | 'read' | 'sent' | 'unsent' = 'all'): Promise<SmsMessage[]> {
    await this.channel.execute('AT+CMGF=0')

    const statusCode = PDU_LIST_STATUS[status] ?? 4
    const result = await this.channel.execute(`AT+CMGL=${statusCode}`)

    // Parse response: alternating header + PDU lines
    const segments: DecodedSegment[] = []
    const { lines } = result

    for (let i = 0; i < lines.length; i++) {
      const headerLine = lines[i]
      if (headerLine === undefined) continue

      const headerMatch = CMGL_PDU_REGEX.exec(headerLine)
      if (!headerMatch) continue

      const [, indexStr, statusStr] = headerMatch
      if (indexStr === undefined || statusStr === undefined) continue

      const msgStatus = PDU_STATUS_MAP[Number.parseInt(statusStr, 10)]
      if (msgStatus === undefined) continue

      // Next line is the PDU hex
      const pduLine = lines[i + 1]
      if (pduLine === undefined || pduLine.startsWith('+CMGL:')) continue
      i++ // skip PDU line in next iteration

      const pdu = decodePduDeliver(pduLine)

      segments.push({
        index: Number.parseInt(indexStr, 10),
        status: msgStatus,
        pdu,
      })
    }

    return assembleMessages(segments)
  }

  /**
   * Read a single SMS by index.
   *
   * Uses PDU mode for proper encoding support. Returns the decoded message
   * with sender, text, and timestamp extracted from the PDU.
   */
  async read(index: number): Promise<SmsMessage> {
    await this.channel.execute('AT+CMGF=0')

    const result = await this.channel.execute(`AT+CMGR=${index}`)
    const headerLine = result.lines[0]
    if (!headerLine) {
      throw new ParseError(`No SMS at index ${index}`, result.lines.join('\n'))
    }

    const headerMatch = CMGR_PDU_REGEX.exec(headerLine)
    if (!headerMatch) {
      throw new ParseError('Failed to parse PDU SMS header', headerLine)
    }

    const [, statusStr] = headerMatch
    if (statusStr === undefined) {
      throw new ParseError('Incomplete SMS: missing status', headerLine)
    }

    const msgStatus = PDU_STATUS_MAP[Number.parseInt(statusStr, 10)]
    if (msgStatus === undefined) {
      throw new ParseError(`Unknown SMS status code: ${statusStr}`, headerLine)
    }

    const pduLine = result.lines[1]
    if (pduLine === undefined) {
      throw new ParseError(`No PDU data for SMS at index ${index}`, result.lines.join('\n'))
    }

    const pdu = decodePduDeliver(pduLine)

    return {
      index,
      status: msgStatus,
      from: pdu.sender,
      text: pdu.text,
      timestamp: pdu.timestamp,
    }
  }

  /** Delete a single SMS by index */
  async delete(index: number): Promise<void> {
    await this.channel.execute(`AT+CMGD=${index}`)
  }

  /**
   * Query SMS storage counts via AT+CPMS?
   *
   * Response: +CPMS: "ME",45,500,"ME",45,500,"ME",45,500
   * Three storage triplets (read, write, receive): name,used,total.
   * First triplet is the read storage -- used as inbox count.
   */
  async count(): Promise<SmsCount> {
    const result = await this.channel.execute('AT+CPMS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CPMS? returned no data', result.lines.join('\n'))
    }

    const [, usedStr, totalStr] = CPMS_REGEX.exec(line) ?? []
    if (usedStr === undefined || totalStr === undefined) {
      throw new ParseError('Failed to parse AT+CPMS? response', line)
    }

    return {
      inbox: Number.parseInt(usedStr, 10),
      capacity: Number.parseInt(totalStr, 10),
    }
  }
}

// ─── Multipart Reassembly ───────────────────────────────────────────────────

/**
 * Group concat key: sender + reference number.
 * Messages from different senders with the same ref are separate messages.
 */
function concatKey(sender: string, concat: ConcatInfo): string {
  return `${sender}:${concat.reference}`
}

/** Intermediate accumulator for multipart assembly */
interface MultipartGroup {
  readonly sender: string
  readonly status: SmsMessage['status']
  readonly firstIndex: number
  readonly concat: ConcatInfo
  readonly parts: Map<number, { text: string; timestamp: Date }>
}

/**
 * Assemble decoded segments into SmsMessages.
 *
 * Single-part messages pass through directly.
 * Multipart segments are grouped by sender + concat reference,
 * sorted by part number, and joined into a single message.
 *
 * The assembled message uses:
 * - index of the first received segment (for deletion/reference)
 * - timestamp of the first part (part 1)
 * - status of the first received segment
 */
function assembleMessages(segments: readonly DecodedSegment[]): SmsMessage[] {
  const singles: SmsMessage[] = []
  const groups = new Map<string, MultipartGroup>()

  for (const seg of segments) {
    if (seg.pdu.concat === undefined) {
      // Single-part message
      singles.push({
        index: seg.index,
        status: seg.status,
        from: seg.pdu.sender,
        text: seg.pdu.text,
        timestamp: seg.pdu.timestamp,
      })
      continue
    }

    const key = concatKey(seg.pdu.sender, seg.pdu.concat)
    let group = groups.get(key)

    if (group === undefined) {
      group = {
        sender: seg.pdu.sender,
        status: seg.status,
        firstIndex: seg.index,
        concat: seg.pdu.concat,
        parts: new Map(),
      }
      groups.set(key, group)
    }

    group.parts.set(seg.pdu.concat.partNumber, {
      text: seg.pdu.text,
      timestamp: seg.pdu.timestamp,
    })
  }

  // Assemble multipart groups
  const assembled: SmsMessage[] = []
  for (const group of groups.values()) {
    const sortedParts: string[] = []
    let timestamp: Date | undefined

    for (let i = 1; i <= group.concat.totalParts; i++) {
      const part = group.parts.get(i)
      if (part !== undefined) {
        sortedParts.push(part.text)
        // Use timestamp of part 1 for the assembled message
        if (i === 1) {
          timestamp = part.timestamp
        }
      }
      // Missing parts: gap in text (partial delivery)
    }

    assembled.push({
      index: group.firstIndex,
      status: group.status,
      from: group.sender,
      text: sortedParts.join(''),
      timestamp: timestamp ?? new Date(),
    })
  }

  const all = [...singles, ...assembled]
  // Sort by timestamp descending (newest first)
  all.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  return all
}
