/**
 * PDU-SUBMIT encoder for SMS sending.
 *
 * 3GPP TS 23.040 section 9.2.2.2 defines the SMS-SUBMIT PDU format.
 * This encoder handles UCS-2 messages only -- GSM 7-bit text uses text mode.
 *
 * PDU-SUBMIT structure (after SCA):
 *   [SCA_LEN] [PDU_TYPE] [MR] [DA_LEN DA_TYPE DA...] [PID] [DCS] [UDL] [UD...]
 *
 * The modem expects the PDU as a hex string after the AT+CMGS=<length> prompt,
 * where <length> is the number of octets EXCLUDING the SCA field.
 *
 * Concatenated SMS (3GPP TS 23.040 section 9.2.3.24.1):
 * Long messages are split into segments with a User Data Header (UDH)
 * containing concatenation information. Each segment is sent as a separate
 * SMS-SUBMIT PDU. The receiving device reassembles them using the reference
 * number, total parts, and part number from the UDH.
 */

// TP-MTI = 01 (SMS-SUBMIT), TP-RD = 0, TP-VPF = 00 (no VP),
// TP-SRR = 0, TP-UDHI = 0, TP-RP = 0
const PDU_TYPE_SMS_SUBMIT = 0x01

// TP-UDHI = 1 (bit 6) — User Data Header present
const PDU_TYPE_SMS_SUBMIT_WITH_UDH = 0x41

// Message Reference: 0x00 lets the modem assign it
const MESSAGE_REFERENCE = 0x00

// Protocol Identifier: default interworking
const PROTOCOL_ID = 0x00

// Data Coding Scheme: UCS-2 (3GPP TS 23.038 section 4)
const DCS_UCS2 = 0x08

// Type-of-Address: international format (1 001 0001 = 0x91)
const TON_INTERNATIONAL = 0x91

// Type-of-Address: unknown/national format (1 000 0001 = 0x81)
const TON_UNKNOWN = 0x81

// Maximum UCS-2 user data octets per single SMS (140 octets = 70 UCS-2 chars)
const MAX_UCS2_OCTETS = 140

// UDH for concatenation: 6 octets (05 00 03 REF TOTAL PART)
// 3GPP TS 23.040 section 9.2.3.24 — Information Element Identifier 0x00
const UDH_CONCAT_LENGTH = 6

// Max UCS-2 data octets per segment when UDH is present (140 - 6 = 134 = 67 chars)
const MAX_UCS2_OCTETS_WITH_UDH = MAX_UCS2_OCTETS - UDH_CONCAT_LENGTH

// Max UCS-2 characters per segment
const MAX_UCS2_CHARS_SINGLE = MAX_UCS2_OCTETS / 2
const MAX_UCS2_CHARS_CONCAT = MAX_UCS2_OCTETS_WITH_UDH / 2

// Max segments per concatenated message (255 per 3GPP, practical limit lower)
const MAX_CONCAT_PARTS = 255

// Concatenation reference counter (wraps at 256)
let concatRefCounter = 0

/** PDU encoding result: the hex string and octet count for AT+CMGS */
export interface PduResult {
  /** Hex-encoded PDU string (sent after the > prompt) */
  readonly pdu: string
  /** Number of TPDU octets (excluding SCA), used in AT+CMGS=<length> */
  readonly length: number
}

/**
 * Encode SMS-SUBMIT PDU(s) for UCS-2 text.
 *
 * For short messages (<= 70 chars), returns a single-element array.
 * For long messages, returns multiple PDUs with concatenation UDH headers
 * per 3GPP TS 23.040 section 9.2.3.24.1.
 *
 * @param to - Destination phone number (e.g. "+37491234567")
 * @param text - Unicode text to send
 * @returns Array of PDU results (one per segment)
 */
export function encodePduSubmit(to: string, text: string): PduResult[] {
  // Count UTF-16 code units (charCodeAt units), not code points
  const utf16Length = text.length

  if (utf16Length <= MAX_UCS2_CHARS_SINGLE) {
    return [encodeSinglePdu(to, text)]
  }

  return encodeConcatenatedPdus(to, text)
}

/** Encode a single (non-concatenated) SMS-SUBMIT PDU */
function encodeSinglePdu(to: string, text: string): PduResult {
  const sca = '00'
  const pduType = toHexByte(PDU_TYPE_SMS_SUBMIT)
  const mr = toHexByte(MESSAGE_REFERENCE)
  const da = encodeAddress(to)
  const pid = toHexByte(PROTOCOL_ID)
  const dcs = toHexByte(DCS_UCS2)
  const udOctets = text.length * 2
  const udl = toHexByte(udOctets)
  const ud = encodeUcs2(text)

  const tpdu = `${pduType}${mr}${da}${pid}${dcs}${udl}${ud}`
  const tpduOctets = tpdu.length / 2

  return { pdu: `${sca}${tpdu}`, length: tpduOctets }
}

/**
 * Encode a long message as concatenated SMS-SUBMIT PDUs.
 *
 * Each segment includes a 6-byte UDH with concatenation IE:
 *   05  — UDH length (5 bytes follow)
 *   00  — IEI: concatenated short messages, 8-bit reference
 *   03  — IE data length (3 bytes)
 *   REF — reference number (same across all segments)
 *   TOT — total number of segments
 *   SEQ — segment sequence number (1-based)
 *
 * UDL includes both UDH and user data octets.
 */
function encodeConcatenatedPdus(to: string, text: string): PduResult[] {
  const segments = splitUcs2Text(text, MAX_UCS2_CHARS_CONCAT)

  if (segments.length > MAX_CONCAT_PARTS) {
    throw new Error(
      `SMS text too long: ${segments.length} segments needed (max ${MAX_CONCAT_PARTS})`,
    )
  }

  const ref = nextConcatRef()
  const totalParts = segments.length
  const results: PduResult[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === undefined) continue

    const partNumber = i + 1
    const sca = '00'
    const pduType = toHexByte(PDU_TYPE_SMS_SUBMIT_WITH_UDH)
    const mr = toHexByte(MESSAGE_REFERENCE)
    const da = encodeAddress(to)
    const pid = toHexByte(PROTOCOL_ID)
    const dcs = toHexByte(DCS_UCS2)

    // UDH: 05 00 03 REF TOTAL PART
    const udh =
      `${toHexByte(0x05)}${toHexByte(0x00)}${toHexByte(0x03)}` +
      `${toHexByte(ref)}${toHexByte(totalParts)}${toHexByte(partNumber)}`

    const ud = encodeUcs2(segment)
    const segmentDataOctets = segment.length * 2
    const udl = toHexByte(UDH_CONCAT_LENGTH + segmentDataOctets)

    const tpdu = `${pduType}${mr}${da}${pid}${dcs}${udl}${udh}${ud}`
    const tpduOctets = tpdu.length / 2

    results.push({ pdu: `${sca}${tpdu}`, length: tpduOctets })
  }

  return results
}

/**
 * Split UCS-2 text into segments, respecting surrogate pairs.
 *
 * UTF-16 surrogate pairs (emoji, etc.) must not be split across segments.
 * A surrogate pair takes 2 code units (4 octets), so if it doesn't fit
 * in the current segment, it goes to the next one.
 */
function splitUcs2Text(text: string, maxCharsPerSegment: number): string[] {
  const segments: string[] = []
  let offset = 0

  while (offset < text.length) {
    let segmentEnd = offset
    let charsInSegment = 0

    while (segmentEnd < text.length && charsInSegment < maxCharsPerSegment) {
      const code = text.charCodeAt(segmentEnd)
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff

      if (isHighSurrogate) {
        // Surrogate pair = 2 code units = 2 UCS-2 chars
        if (charsInSegment + 2 > maxCharsPerSegment) break
        segmentEnd += 2
        charsInSegment += 2
      } else {
        segmentEnd += 1
        charsInSegment += 1
      }
    }

    segments.push(text.slice(offset, segmentEnd))
    offset = segmentEnd
  }

  return segments
}

/** Get next concatenation reference number (0-255, wrapping) */
export function nextConcatRef(): number {
  const ref = concatRefCounter
  concatRefCounter = (concatRefCounter + 1) % 256
  return ref
}

/** Reset concat reference counter (for testing) */
export function _resetConcatRef(value = 0): void {
  concatRefCounter = value
}

// -- Address encoding (3GPP TS 24.011 section 8.2.5.1) -------------------------

/**
 * Encode a phone number into PDU address format.
 *
 * Format: [address-length] [type-of-address] [BCD digits, nibble-swapped]
 *
 * Address-length is the number of useful digits (excluding '+').
 * Type-of-address is 0x91 for international ('+' prefix) or 0x81 for unknown.
 * Digits are BCD-encoded with nibble swapping: "1234" -> "2143".
 * Odd-length numbers get padded with 'F': "12345" -> "214365" -> "2143F5".
 */
export function encodeAddress(number: string): string {
  const international = number.startsWith('+')
  const digits = international ? number.slice(1) : number
  const addressLength = toHexByte(digits.length)
  const typeOfAddress = toHexByte(international ? TON_INTERNATIONAL : TON_UNKNOWN)
  const bcd = swapNibbles(digits)

  return `${addressLength}${typeOfAddress}${bcd}`
}

/**
 * BCD-encode digits with nibble swapping per 3GPP TS 24.011.
 *
 * Each pair of digits is swapped: "1234" -> "2143".
 * Odd-length strings are padded with 'F': "12345" -> "2143F5".
 */
function swapNibbles(digits: string): string {
  const padded = digits.length % 2 === 0 ? digits : `${digits}F`
  let result = ''
  for (let i = 0; i < padded.length; i += 2) {
    result += padded[i + 1]
    result += padded[i]
  }
  return result
}

// -- UCS-2 encoding -----------------------------------------------------------

/**
 * Encode text as UCS-2 big-endian hex string.
 *
 * Each character becomes 4 hex digits (2 octets) in big-endian order.
 * Handles Basic Multilingual Plane characters (U+0000 to U+FFFF).
 */
function encodeUcs2(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    result += toHexByte(code >> 8)
    result += toHexByte(code & 0xff)
  }
  return result
}

// -- Helpers ------------------------------------------------------------------

/** Convert a byte value (0-255) to a 2-character uppercase hex string. */
export function toHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0')
}
