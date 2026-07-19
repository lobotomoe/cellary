/**
 * PDU-DELIVER decoder for incoming SMS messages.
 *
 * 3GPP TS 23.040 section 9.2.2.1 defines the SMS-DELIVER PDU format:
 *   [SCA] [PDU_TYPE] [OA] [PID] [DCS] [SCTS] [UDL] [UD]
 *
 * This decoder handles:
 * - GSM 7-bit default alphabet (DCS 0x00)
 * - UCS-2 / UTF-16BE encoding (DCS 0x08)
 * - Concatenation UDH (IEI 0x00 for 8-bit ref, IEI 0x08 for 16-bit ref)
 * - BCD-encoded addresses and timestamps
 *
 * The decoder returns structured data per-segment. Multipart reassembly
 * (grouping segments by concat reference) is handled by the caller.
 */

import { ParseError } from '../../../../errors.js'

// ─── Types ──────────────────────────────────────────────────────────────────

/** Concatenation info extracted from UDH */
export interface ConcatInfo {
  /** Reference number shared by all parts of the same message */
  readonly reference: number
  /** Total number of parts */
  readonly totalParts: number
  /** 1-based part number of this segment */
  readonly partNumber: number
}

/** Decoded SMS-DELIVER PDU */
export interface DecodedPdu {
  /** Originating address (sender phone number) */
  readonly sender: string
  /** Decoded message text */
  readonly text: string
  /** Service Centre Timestamp */
  readonly timestamp: Date
  /** Data coding scheme indicator */
  readonly encoding: 'gsm7' | 'ucs2'
  /** Concatenation info (present only for multipart segments) */
  readonly concat?: ConcatInfo | undefined
}

// ─── Constants ──────────────────────────────────────────────────────────────

// Type-of-Address masks (3GPP TS 24.008 section 10.5.4.7)
const TON_INTERNATIONAL = 0x91
const TON_ALPHANUMERIC = 0xd0

// UDH Information Element Identifiers (3GPP TS 23.040 section 9.2.3.24)
const IEI_CONCAT_8BIT = 0x00
const IEI_CONCAT_16BIT = 0x08

// TP-MTI mask (bits 0-1 of first octet)
const MTI_DELIVER = 0x00

// TP-UDHI flag (bit 6 of first octet)
const UDHI_BIT = 0x40

// 3GPP TS 23.040 section 9.2.3.11 -- timezone in quarter-hour increments
const TZ_QUARTER_HOUR_MINUTES = 15

// GSM 7-bit septets per SMS (160 max)
const GSM7_SEPTET_BITS = 7

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Decode an SMS-DELIVER PDU hex string.
 *
 * @param hex - Full PDU hex string including SCA
 * @returns Decoded PDU with sender, text, timestamp, and optional concat info
 */
export function decodePduDeliver(hex: string): DecodedPdu {
  const reader = createHexReader(hex)

  // 1. Service Centre Address
  const scaLength = reader.readByte()
  if (scaLength > 0) {
    reader.skip(scaLength) // skip SCA type + BCD digits
  }

  // 2. PDU type octet
  const pduType = reader.readByte()
  const mti = pduType & 0x03
  if (mti !== MTI_DELIVER) {
    throw new ParseError(`Expected SMS-DELIVER (MTI=0), got MTI=${mti}`, hex)
  }
  const hasUdhi = (pduType & UDHI_BIT) !== 0

  // 3. Originating Address
  const sender = readAddress(reader)

  // 4. Protocol Identifier (skip)
  reader.skip(1)

  // 5. Data Coding Scheme
  const dcsRaw = reader.readByte()
  const encoding = parseDcs(dcsRaw)

  // 6. Service Centre Timestamp (7 octets BCD)
  const timestamp = readTimestamp(reader)

  // 7. User Data Length
  const udl = reader.readByte()

  // 8. User Data (with optional UDH)
  let concat: ConcatInfo | undefined
  let text: string

  if (hasUdhi) {
    const udhLength = reader.readByte()
    const udhEnd = reader.position + udhLength * 2 // in hex chars
    concat = parseUdhConcat(reader, udhEnd)

    // Skip remaining UDH IEs we don't understand
    reader.seekTo(udhEnd)

    if (encoding === 'gsm7') {
      // UDH occupies ceil((udhLength + 1) * 8 / 7) septets
      const udhBits = (udhLength + 1) * 8
      const udhSeptets = Math.ceil(udhBits / GSM7_SEPTET_BITS)
      const dataSeptets = udl - udhSeptets
      // Fill bits: padding after UDH to align to septet boundary
      const fillBits = udhSeptets * GSM7_SEPTET_BITS - udhBits
      text = decodeGsm7(reader.remaining(), dataSeptets, fillBits)
    } else {
      const dataOctets = udl - (udhLength + 1)
      text = decodeUcs2(reader, dataOctets)
    }
  } else {
    if (encoding === 'gsm7') {
      text = decodeGsm7(reader.remaining(), udl, 0)
    } else {
      text = decodeUcs2(reader, udl)
    }
  }

  return { sender, text, timestamp, encoding, concat }
}

// ─── Hex Reader ─────────────────────────────────────────────────────────────

interface HexReader {
  /** Current position in hex string (2 chars = 1 octet) */
  position: number
  /** Read one octet and advance */
  readByte(): number
  /** Read N octets as hex substring and advance */
  readHex(octets: number): string
  /** Skip N octets */
  skip(octets: number): void
  /** Move to absolute hex position */
  seekTo(hexPos: number): void
  /** Return remaining hex from current position */
  remaining(): string
}

function createHexReader(hex: string): HexReader {
  const normalized = hex.toUpperCase()
  let pos = 0

  return {
    get position() {
      return pos
    },
    set position(v: number) {
      pos = v
    },

    readByte(): number {
      if (pos + 2 > normalized.length) {
        throw new ParseError('PDU too short: unexpected end of data', hex)
      }
      const value = Number.parseInt(normalized.slice(pos, pos + 2), 16)
      pos += 2
      return value
    },

    readHex(octets: number): string {
      const chars = octets * 2
      if (pos + chars > normalized.length) {
        throw new ParseError('PDU too short: unexpected end of data', hex)
      }
      const result = normalized.slice(pos, pos + chars)
      pos += chars
      return result
    },

    skip(octets: number): void {
      pos += octets * 2
    },

    seekTo(hexPos: number): void {
      pos = hexPos
    },

    remaining(): string {
      return normalized.slice(pos)
    },
  }
}

// ─── Address Decoding ───────────────────────────────────────────────────────

/**
 * Read an address field (OA or DA) from the PDU.
 *
 * Format: [address-length] [type-of-address] [BCD digits]
 * address-length = number of useful digits (not octets)
 * BCD digits are nibble-swapped, padded with F for odd lengths.
 */
function readAddress(reader: HexReader): string {
  const digitCount = reader.readByte()
  const typeOfAddress = reader.readByte()

  // Number of octets for the BCD digits = ceil(digitCount / 2)
  const bcdOctets = Math.ceil(digitCount / 2)
  const bcdHex = reader.readHex(bcdOctets)

  if ((typeOfAddress & 0xf0) === (TON_ALPHANUMERIC & 0xf0)) {
    // Alphanumeric address: GSM 7-bit packed in the BCD field
    const septets = Math.floor((digitCount * 4) / 7)
    return decodeGsm7(bcdHex, septets, 0)
  }

  // Numeric address: unswap nibbles
  const digits = unswapNibbles(bcdHex, digitCount)
  const prefix = typeOfAddress === TON_INTERNATIONAL ? '+' : ''
  return `${prefix}${digits}`
}

/**
 * Reverse nibble-swapping to recover original digits.
 * "2143F5" with count=5 -> "12345"
 */
function unswapNibbles(bcdHex: string, digitCount: number): string {
  let result = ''
  for (let i = 0; i < bcdHex.length; i += 2) {
    const lo = bcdHex[i + 1]
    const hi = bcdHex[i]
    if (lo !== undefined && lo !== 'F') result += lo
    if (hi !== undefined && hi !== 'F') result += hi
  }
  return result.slice(0, digitCount)
}

// ─── Timestamp Decoding ─────────────────────────────────────────────────────

/**
 * Read a 7-octet BCD-encoded SCTS timestamp.
 *
 * Each octet is two BCD digits (nibble-swapped):
 *   YY MM DD HH MM SS TZ
 * TZ: bit 3 = sign (1=negative), bits 0-2 + bits 4-7 = value in quarter-hours.
 */
function readTimestamp(reader: HexReader): Date {
  const deswap = (b: number): number => (b & 0x0f) * 10 + ((b >> 4) & 0x0f)

  const year = 2000 + deswap(reader.readByte())
  const month = deswap(reader.readByte()) - 1 // JS months are 0-based
  const day = deswap(reader.readByte())
  const hours = deswap(reader.readByte())
  const minutes = deswap(reader.readByte())
  const seconds = deswap(reader.readByte())

  // Timezone: nibble-swapped, bit 3 of first nibble = sign
  const tzByte = reader.readByte()
  const tzSign = (tzByte & 0x08) !== 0 ? -1 : 1
  const tzValue = (tzByte & 0x07) * 10 + ((tzByte >> 4) & 0x0f)
  const tzOffsetMinutes = tzSign * tzValue * TZ_QUARTER_HOUR_MINUTES

  const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds))
  date.setUTCMinutes(date.getUTCMinutes() - tzOffsetMinutes)

  return date
}

// ─── DCS Parsing ────────────────────────────────────────────────────────────

/**
 * Parse Data Coding Scheme to determine text encoding.
 *
 * 3GPP TS 23.038 section 4:
 * - Coding group 00xx: bits 2-3 = alphabet (00=GSM7, 10=UCS2)
 * - Coding group 01xx (message class): bits 2-3 = alphabet
 * - Coding group 1111 (data coding/message class): bit 2 = 0 GSM7, 1 8-bit
 */
function parseDcs(dcs: number): 'gsm7' | 'ucs2' {
  const highNibble = (dcs >> 4) & 0x0f

  // General data coding: groups 00xx and 01xx (3GPP TS 23.038 section 4)
  if (highNibble <= 0x03 || (highNibble >= 0x04 && highNibble <= 0x07)) {
    const alphabet = (dcs >> 2) & 0x03
    if (alphabet === 0x00) return 'gsm7'
    if (alphabet === 0x02) return 'ucs2'
    // 0x01 = 8-bit binary data (not text), 0x03 = reserved
    throw new ParseError(
      `Unsupported SMS encoding: DCS 0x${dcs.toString(16)} (alphabet=${alphabet})`,
      `DCS=${dcs}`,
    )
  }

  // Message waiting groups (1100, 1101, 1110) -- GSM7 or UCS2
  if (highNibble >= 0x0c && highNibble <= 0x0e) {
    if (highNibble === 0x0e) return 'ucs2'
    return 'gsm7'
  }

  // Data coding/message class (1111): bit 2 selects alphabet
  if (highNibble === 0x0f) {
    if ((dcs & 0x04) === 0) return 'gsm7'
    // bit 2 = 1 means 8-bit binary data
    throw new ParseError(
      `Unsupported SMS encoding: DCS 0x${dcs.toString(16)} (8-bit binary)`,
      `DCS=${dcs}`,
    )
  }

  throw new ParseError(`Unknown SMS DCS group: 0x${dcs.toString(16)}`, `DCS=${dcs}`)
}

// ─── UDH Parsing ────────────────────────────────────────────────────────────

/**
 * Parse UDH to extract concatenation info.
 * Scans IEs until udhEnd position, looking for concat IEI (0x00 or 0x08).
 */
function parseUdhConcat(reader: HexReader, udhEnd: number): ConcatInfo | undefined {
  while (reader.position < udhEnd) {
    const iei = reader.readByte()
    const ieLen = reader.readByte()

    if (iei === IEI_CONCAT_8BIT && ieLen === 3) {
      const reference = reader.readByte()
      const totalParts = reader.readByte()
      const partNumber = reader.readByte()
      return { reference, totalParts, partNumber }
    }

    if (iei === IEI_CONCAT_16BIT && ieLen === 4) {
      const refHi = reader.readByte()
      const refLo = reader.readByte()
      const reference = (refHi << 8) | refLo
      const totalParts = reader.readByte()
      const partNumber = reader.readByte()
      return { reference, totalParts, partNumber }
    }

    // Skip unknown IE
    reader.skip(ieLen)
  }

  return undefined
}

// ─── GSM 7-bit Decoding ─────────────────────────────────────────────────────

// GSM 7-bit Basic Character Set (3GPP TS 23.038 section 6.2.1)
// Index -> Unicode character
// prettier-ignore
const GSM7_TABLE: readonly string[] = [
  '@',
  '\u00A3',
  '$',
  '\u00A5',
  '\u00E8',
  '\u00E9',
  '\u00F9',
  '\u00EC',
  '\u00F2',
  '\u00C7',
  '\n',
  '\u00D8',
  '\u00F8',
  '\r',
  '\u00C5',
  '\u00E5',
  '\u0394',
  '_',
  '\u03A6',
  '\u0393',
  '\u039B',
  '\u03A9',
  '\u03A0',
  '\u03A8',
  '\u03A3',
  '\u0398',
  '\u039E',
  /* ESC */ '',
  '\u00C6',
  '\u00E6',
  '\u00DF',
  '\u00C9',
  ' ',
  '!',
  '"',
  '#',
  '\u00A4',
  '%',
  '&',
  "'",
  '(',
  ')',
  '*',
  '+',
  ',',
  '-',
  '.',
  '/',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  ':',
  ';',
  '<',
  '=',
  '>',
  '?',
  '\u00A1',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  '\u00C4',
  '\u00D6',
  '\u00D1',
  '\u00DC',
  '\u00A7',
  '\u00BF',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '\u00E4',
  '\u00F6',
  '\u00F1',
  '\u00FC',
  '\u00E0',
]

// GSM 7-bit Extension Table (3GPP TS 23.038 section 6.2.1.1)
// Accessed via ESC (0x1B) prefix
const GSM7_EXTENSION: Readonly<Record<number, string>> = {
  10: '\f', // form feed
  20: '^',
  40: '{',
  41: '}',
  47: '\\',
  60: '[',
  61: '~',
  62: ']',
  64: '|',
  101: '\u20AC', // euro sign
}

const GSM7_ESC = 0x1b

/**
 * Decode GSM 7-bit packed data from hex string.
 *
 * GSM 7-bit packing: septets are packed into octets LSB-first.
 * Each septet is 7 bits. 8 septets fit into 7 octets.
 *
 * @param hex - Hex string of packed octets
 * @param septetCount - Number of septets to decode
 * @param fillBits - Number of fill bits at the start (after UDH alignment)
 */
function decodeGsm7(hex: string, septetCount: number, fillBits: number): string {
  // Convert hex to byte array
  const bytes: number[] = []
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }

  // Fail loud on truncated user data rather than fabricating zero bits (which
  // would materialize as spurious '@' characters — septet 0). A well-formed PDU
  // carries exactly ceil((fillBits + septets*7) / 8) octets.
  const requiredOctets = Math.ceil((fillBits + septetCount * GSM7_SEPTET_BITS) / 8)
  if (bytes.length < requiredOctets) {
    throw new ParseError(
      `GSM7 user data truncated: ${septetCount} septets need ${requiredOctets} octets, ` +
        `got ${bytes.length}`,
      hex,
    )
  }

  // Unpack septets from bit stream
  let result = ''
  let bitOffset = fillBits
  let escaped = false

  for (let i = 0; i < septetCount; i++) {
    const byteIndex = Math.floor(bitOffset / 8)
    const bitPos = bitOffset % 8

    let septet: number
    const currentByte = bytes[byteIndex]
    if (currentByte === undefined) {
      throw new ParseError(`GSM7 decode overran user data at septet ${i}`, hex)
    }

    if (bitPos <= 1) {
      // Septet fits in one byte
      septet = (currentByte >> bitPos) & 0x7f
    } else {
      // Septet spans two bytes. requiredOctets guarantees the next octet exists
      // whenever a septet straddles the boundary, so a missing byte is a bug.
      const nextByte = bytes[byteIndex + 1]
      if (nextByte === undefined) {
        throw new ParseError(`GSM7 decode overran user data at septet ${i}`, hex)
      }
      const combined = currentByte | (nextByte << 8)
      septet = (combined >> bitPos) & 0x7f
    }

    bitOffset += GSM7_SEPTET_BITS

    if (escaped) {
      const ext = GSM7_EXTENSION[septet]
      result += ext ?? '' // unknown extension chars are dropped per spec
      escaped = false
      continue
    }

    if (septet === GSM7_ESC) {
      escaped = true
      continue
    }

    const char = GSM7_TABLE[septet]
    if (char !== undefined) {
      result += char
    }
  }

  return result
}

// ─── UCS-2 Decoding ─────────────────────────────────────────────────────────

/**
 * Decode UCS-2 big-endian data from the reader.
 * Each code point is 2 octets.
 */
function decodeUcs2(reader: HexReader, octets: number): string {
  let result = ''
  for (let i = 0; i + 2 <= octets; i += 2) {
    const hi = reader.readByte()
    const lo = reader.readByte()
    result += String.fromCharCode((hi << 8) | lo)
  }
  return result
}
