import { describe, expect, it } from 'vitest'
import { decodePduDeliver } from '../../../../src/protocols/at/services/sms/pdu-decode.js'
import { encodeGsm7SubmitPdus } from '../../../../src/protocols/at/services/sms/pdu-encode-gsm7.js'

/**
 * Turn an encoded SMS-SUBMIT PDU into an SMS-DELIVER PDU with the same user
 * data, so the existing (tested) decoder can verify the encoded septets.
 *
 * SUBMIT layout after SCA: [type][MR][DA][PID][DCS][UDL][UD]
 * DELIVER layout after SCA: [type][OA][PID][DCS][SCTS(7)][UDL][UD]
 * We reuse the address as OA and splice in a fixed timestamp.
 */
const FIXED_SCTS = '42301021030080' // 24/03/01 12:30:00 +02:00

function submitToDeliverText(pduHex: string): { text: string; udhi: boolean } {
  // Strip SCA (first octet = 00 here).
  let pos = 2
  const readByte = (): number => {
    const b = Number.parseInt(pduHex.slice(pos, pos + 2), 16)
    pos += 2
    return b
  }
  const submitType = readByte()
  const udhi = (submitType & 0x40) !== 0
  readByte() // MR
  const daLen = readByte()
  const daOctets = Math.ceil(daLen / 2)
  const oa = pduHex.slice(pos - 2, pos + 2 + daOctets * 2) // [len][type][digits]
  pos += 2 + daOctets * 2
  const pid = pduHex.slice(pos, pos + 2)
  pos += 2
  const dcs = pduHex.slice(pos, pos + 2)
  pos += 2
  const rest = pduHex.slice(pos) // [UDL][UD]

  const deliverType = udhi ? '40' : '00'
  const deliver = `00${deliverType}${oa}${pid}${dcs}${FIXED_SCTS}${rest}`
  return { text: decodePduDeliver(deliver).text, udhi }
}

function roundTrip(text: string): string {
  const parts = encodeGsm7SubmitPdus('+1234567890', text)
  // Reassemble multi-segment payloads in order.
  return parts.map((p) => submitToDeliverText(p.pdu).text).join('')
}

describe('encodeGsm7SubmitPdus()', () => {
  it('round-trips a short message as a single PDU', () => {
    const parts = encodeGsm7SubmitPdus('+1234567890', 'Hello world')
    expect(parts).toHaveLength(1)
    expect(submitToDeliverText(parts[0]?.pdu ?? '').text).toBe('Hello world')
  })

  it.each([1, 7, 8, 9, 159, 160])('round-trips a %i-character basic message', (n) => {
    const text = 'A'.repeat(n)
    const parts = encodeGsm7SubmitPdus('+1234567890', text)
    expect(parts).toHaveLength(1) // <= 160 septets = single SMS
    expect(roundTrip(text)).toBe(text)
  })

  it.each([161, 306, 307, 459])('splits and round-trips a %i-character message', (n) => {
    const text = 'A'.repeat(n)
    const parts = encodeGsm7SubmitPdus('+1234567890', text)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(submitToDeliverText(p.pdu).udhi).toBe(true)
    }
    expect(roundTrip(text)).toBe(text)
  })

  it('counts extension characters as two septets when splitting', () => {
    // 90 euro signs = 180 septets > 160, so it must be concatenated.
    const text = '€'.repeat(90)
    const parts = encodeGsm7SubmitPdus('+1234567890', text)
    expect(parts.length).toBeGreaterThan(1)
    expect(roundTrip(text)).toBe(text)
  })

  it('round-trips mixed basic + extension characters across a boundary', () => {
    const text = `${'x'.repeat(158)}€{}[]~|`.repeat(3)
    expect(roundTrip(text)).toBe(text)
  })

  it('round-trips the full GSM7 basic sentence', () => {
    const text = 'The quick brown fox jumps over 13 lazy dogs! Cost: 5% @ home.'
    expect(roundTrip(text)).toBe(text)
  })
})
