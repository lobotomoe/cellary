/**
 * GSM 7-bit SMS-SUBMIT encoder.
 *
 * The plain text-mode send path (AT+CMGF=1) cannot split a message longer than
 * one SMS, so long GSM 7-bit text must go through PDU mode with concatenation.
 * This encoder packs septets per 3GPP TS 23.038 section 6.1.2.1.1 and builds
 * SMS-SUBMIT PDUs, adding a concatenation UDH for multi-segment messages.
 *
 * The GSM 7-bit alphabet tables are reused from the decoder (single source of
 * truth); every PDU this produces round-trips through decodePduDeliver.
 */

import { encodeAddress, nextConcatRef, type PduResult, toHexByte } from './pdu.js'
import { GSM7_ESC, GSM7_EXTENSION, GSM7_TABLE } from './pdu-decode.js'

// Reverse maps (character -> septet code) derived from the canonical decode tables.
const GSM7_BASIC_ENCODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  for (let i = 0; i < GSM7_TABLE.length; i++) {
    const ch = GSM7_TABLE[i]
    // Skip the ESC slot (index 0x1B, empty string) — it is not a printable char.
    if (ch !== undefined && ch !== '') {
      map.set(ch, i)
    }
  }
  return map
})()

const GSM7_EXTENSION_ENCODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  for (const [code, ch] of Object.entries(GSM7_EXTENSION)) {
    map.set(ch, Number(code))
  }
  return map
})()

// SMS-SUBMIT type octets: MTI=01. 0x41 additionally sets TP-UDHI (bit 6).
const PDU_TYPE_SUBMIT = 0x01
const PDU_TYPE_SUBMIT_WITH_UDH = 0x41
const MESSAGE_REFERENCE = 0x00
const PROTOCOL_ID = 0x00
const DCS_GSM7 = 0x00

// Septet budgets: 160 for a single SMS, 153 with a 6-octet concatenation UDH.
const GSM7_SINGLE_SEPTETS = 160
const GSM7_CONCAT_SEPTETS = 153

// A 6-octet UDH (48 bits) occupies 7 septet slots (49 bits) with one fill bit
// between the header and the first data septet.
const UDH_SEPTET_SLOTS = 7
const UDH_FILL_BITS = 1

const SEPTET_BITS = 7
const OCTET_BITS = 8
const MAX_CONCAT_PARTS = 255

/**
 * Encode GSM 7-bit text into one or more SMS-SUBMIT PDUs.
 *
 * Messages up to 160 septets produce a single PDU; longer ones are split into
 * 153-septet segments with a concatenation UDH. Assumes the text is GSM 7-bit
 * compatible (see `isGsm7BitCompatible`).
 */
export function encodeGsm7SubmitPdus(to: string, text: string): PduResult[] {
  const septets = encodeGsm7Septets(text)
  if (septets.length <= GSM7_SINGLE_SEPTETS) {
    return [buildSinglePdu(to, septets)]
  }
  return buildConcatenatedPdus(to, text)
}

/** Map each character to its septet code(s); extension chars emit ESC + code. */
function encodeGsm7Septets(text: string): number[] {
  const septets: number[] = []
  for (const ch of text) {
    const basic = GSM7_BASIC_ENCODE.get(ch)
    if (basic !== undefined) {
      septets.push(basic)
      continue
    }
    const ext = GSM7_EXTENSION_ENCODE.get(ch)
    if (ext !== undefined) {
      septets.push(GSM7_ESC, ext)
      continue
    }
    throw new Error(`Character not in GSM 7-bit alphabet: ${JSON.stringify(ch)}`)
  }
  return septets
}

/**
 * Pack septets into octets, LSB-first, with `fillBits` zero padding bits before
 * the first septet (used to align data after a UDH). Returns hex.
 */
function packSeptets(septets: readonly number[], fillBits: number): string {
  let hex = ''
  let buffer = 0
  let bits = fillBits
  for (const septet of septets) {
    buffer |= (septet & 0x7f) << bits
    bits += SEPTET_BITS
    while (bits >= OCTET_BITS) {
      hex += toHexByte(buffer & 0xff)
      buffer >>= OCTET_BITS
      bits -= OCTET_BITS
    }
  }
  if (bits > 0) {
    hex += toHexByte(buffer & 0xff)
  }
  return hex
}

function buildSinglePdu(to: string, septets: readonly number[]): PduResult {
  const ud = packSeptets(septets, 0)
  const udl = toHexByte(septets.length) // UDL counts septets for GSM 7-bit
  const tpdu =
    toHexByte(PDU_TYPE_SUBMIT) +
    toHexByte(MESSAGE_REFERENCE) +
    encodeAddress(to) +
    toHexByte(PROTOCOL_ID) +
    toHexByte(DCS_GSM7) +
    udl +
    ud
  return { pdu: `00${tpdu}`, length: tpdu.length / 2 }
}

function buildConcatenatedPdus(to: string, text: string): PduResult[] {
  const segments = splitBySeptetBudget(text, GSM7_CONCAT_SEPTETS)
  if (segments.length > MAX_CONCAT_PARTS) {
    throw new Error(
      `SMS text too long: ${segments.length} segments needed (max ${MAX_CONCAT_PARTS})`,
    )
  }

  const ref = nextConcatRef()
  const total = segments.length
  const results: PduResult[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === undefined) continue
    const septets = encodeGsm7Septets(segment)

    // UDH: 05 00 03 REF TOTAL PART
    const udh =
      toHexByte(0x05) +
      toHexByte(0x00) +
      toHexByte(0x03) +
      toHexByte(ref) +
      toHexByte(total) +
      toHexByte(i + 1)

    const ud = udh + packSeptets(septets, UDH_FILL_BITS)
    const udl = toHexByte(UDH_SEPTET_SLOTS + septets.length)
    const tpdu =
      toHexByte(PDU_TYPE_SUBMIT_WITH_UDH) +
      toHexByte(MESSAGE_REFERENCE) +
      encodeAddress(to) +
      toHexByte(PROTOCOL_ID) +
      toHexByte(DCS_GSM7) +
      udl +
      ud
    results.push({ pdu: `00${tpdu}`, length: tpdu.length / 2 })
  }

  return results
}

/**
 * Split text into segments each within `maxSeptets`, never breaking an
 * extension character's ESC + code pair across a boundary.
 */
function splitBySeptetBudget(text: string, maxSeptets: number): string[] {
  const segments: string[] = []
  let current = ''
  let count = 0
  for (const ch of text) {
    const cost = GSM7_EXTENSION_ENCODE.has(ch) ? 2 : 1
    if (count + cost > maxSeptets) {
      segments.push(current)
      current = ''
      count = 0
    }
    current += ch
    count += cost
  }
  segments.push(current)
  return segments
}
