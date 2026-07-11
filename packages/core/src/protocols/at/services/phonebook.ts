import { ParseError } from '../../../errors.js'
import type {
  NumberFormat,
  PhonebookEntry,
  PhonebookStorage,
  PhonebookStorageInfo,
} from '../../../types.js'
import type { Phonebook } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'

// ── Semantic <-> AT code maps ───────────────────────────────────────────────

const STORAGE_TO_AT: Record<PhonebookStorage, string> = {
  sim: 'SM',
  device: 'ME',
  dialedCalls: 'DC',
  missedCalls: 'MC',
  receivedCalls: 'RC',
  ownNumbers: 'ON',
  fixedDialing: 'FD',
}

const AT_TO_STORAGE: Record<string, PhonebookStorage> = {
  SM: 'sim',
  ME: 'device',
  DC: 'dialedCalls',
  MC: 'missedCalls',
  RC: 'receivedCalls',
  ON: 'ownNumbers',
  FD: 'fixedDialing',
}

/** International type of address per ITU-T (includes country code with +) */
const NUMBER_TYPE_INTERNATIONAL = 145
/** Unknown/national type of address per ITU-T (no country code prefix) */
const NUMBER_TYPE_NATIONAL = 129

function numberTypeToFormat(type: number): NumberFormat {
  return type === NUMBER_TYPE_INTERNATIONAL ? 'international' : 'national'
}

/** Auto-detect number format: starts with '+' -> international (145), else national (129) */
function inferNumberType(number: string): number {
  return number.startsWith('+') ? NUMBER_TYPE_INTERNATIONAL : NUMBER_TYPE_NATIONAL
}

// +CPBS: "<storage>",<used>,<total>
const CPBS_REGEX = /\+CPBS:\s*"([^"]*)",(\d+),(\d+)/

// +CPBR: <index>,"<number>",<type>,"<name>"
// +CPBF: <index>,"<number>",<type>,"<name>"
const CPBR_REGEX = /\+CPB[RF]:\s*(\d+),"([^"]*)",(\d+),"([^"]*)"/

/**
 * Phonebook (contacts) access via standard AT commands.
 *
 * Supports reading, writing, searching, and deleting contacts
 * in various storage locations (SIM, device memory, call logs).
 */
export class PhonebookModule implements Phonebook {
  constructor(private readonly channel: ATChannel) {}

  /**
   * Select phonebook storage and query its capacity.
   *
   * Response: +CPBS: "<storage>",<used>,<total>
   */
  async selectStorage(storage: PhonebookStorage): Promise<PhonebookStorageInfo> {
    const atCode = STORAGE_TO_AT[storage]
    await this.channel.execute(`AT+CPBS="${atCode}"`)

    const result = await this.channel.execute('AT+CPBS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CPBS? returned no data', result.lines.join('\n'))
    }

    const match = CPBS_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CPBS? response', line)
    }

    const [, storageCode, usedStr, totalStr] = match
    if (storageCode === undefined || usedStr === undefined || totalStr === undefined) {
      throw new ParseError('AT+CPBS? missing fields', line)
    }

    const resolvedStorage = AT_TO_STORAGE[storageCode] ?? storage

    return {
      storage: resolvedStorage,
      used: Number.parseInt(usedStr, 10),
      total: Number.parseInt(totalStr, 10),
    }
  }

  /**
   * Read phonebook entries by index range.
   *
   * Response: +CPBR: <index>,"<number>",<type>,"<name>"
   * (one line per entry, empty slots are skipped)
   */
  async read(start: number, end: number): Promise<PhonebookEntry[]> {
    const result = await this.channel.execute(`AT+CPBR=${start},${end}`)
    return this.parseEntries(result.lines)
  }

  /**
   * Find phonebook entries by name substring.
   *
   * Response: +CPBF: <index>,"<number>",<type>,"<name>"
   * (one line per match)
   */
  async find(text: string): Promise<PhonebookEntry[]> {
    const result = await this.channel.execute(`AT+CPBF="${text}"`)
    return this.parseEntries(result.lines)
  }

  /** Write a phonebook entry at a specific index. Number format is auto-detected. */
  async write(index: number, number: string, name: string): Promise<void> {
    const type = inferNumberType(number)
    await this.channel.execute(`AT+CPBW=${index},"${number}",${type},"${name}"`)
  }

  /** Delete a phonebook entry by index (write empty entry). */
  async delete(index: number): Promise<void> {
    await this.channel.execute(`AT+CPBW=${index}`)
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Parse +CPBR/+CPBF response lines into PhonebookEntry[]. */
  private parseEntries(lines: readonly string[]): PhonebookEntry[] {
    const entries: PhonebookEntry[] = []
    for (const line of lines) {
      const match = CPBR_REGEX.exec(line)
      if (match === null) continue

      const [, indexStr, number, typeStr, name] = match
      if (
        indexStr === undefined ||
        number === undefined ||
        typeStr === undefined ||
        name === undefined
      )
        continue

      entries.push({
        index: Number.parseInt(indexStr, 10),
        number,
        format: numberTypeToFormat(Number.parseInt(typeStr, 10)),
        name,
      })
    }
    return entries
  }
}
