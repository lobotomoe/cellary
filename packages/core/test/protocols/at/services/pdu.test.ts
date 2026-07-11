import { beforeEach, describe, expect, it } from 'vitest'
import { _resetConcatRef, encodePduSubmit } from '../../../../src/protocols/at/services/sms/pdu.js'

describe('encodePduSubmit()', () => {
  beforeEach(() => {
    _resetConcatRef()
  })

  describe('single segment (<= 70 chars)', () => {
    it('encodes a simple UCS-2 message to international number', () => {
      const segments = encodePduSubmit('+1234567890', 'AB')
      expect(segments).toHaveLength(1)

      const [segment] = segments
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu, length } = segment

      // SCA: 00
      expect(pdu.slice(0, 2)).toBe('00')

      // PDU type: 01 (SMS-SUBMIT, no VP, no UDHI)
      expect(pdu.slice(2, 4)).toBe('01')

      // MR: 00
      expect(pdu.slice(4, 6)).toBe('00')

      // DA length: 0A (10 digits)
      expect(pdu.slice(6, 8)).toBe('0A')

      // DA type: 91 (international)
      expect(pdu.slice(8, 10)).toBe('91')

      // DA BCD: 1234567890 -> 2143658709 (nibble-swapped)
      expect(pdu.slice(10, 20)).toBe('2143658709')

      // PID: 00
      expect(pdu.slice(20, 22)).toBe('00')

      // DCS: 08 (UCS-2)
      expect(pdu.slice(22, 24)).toBe('08')

      // UDL: 04 (2 chars * 2 octets = 4 octets)
      expect(pdu.slice(24, 26)).toBe('04')

      // UD: A=0041, B=0042
      expect(pdu.slice(26)).toBe('00410042')

      // TPDU length: everything after SCA (pdu.length/2 - 1)
      expect(length).toBe((pdu.length - 2) / 2)
    })

    it('encodes Cyrillic text', () => {
      const text = '\u041F\u0440\u0438\u0432\u0435\u0442'
      const [segment] = encodePduSubmit('+79001234567', text)
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment

      // SCA(2) + PDU(2) + MR(2) + DA_len(2) + DA_type(2) + DA_BCD(12) + PID(2) + DCS(2) = 26
      const udlStart = 26
      expect(pdu.slice(udlStart, udlStart + 2)).toBe('0C') // 6 chars * 2 = 12 octets

      const ud = pdu.slice(udlStart + 2)
      expect(ud).toBe('041F04400438043204350442')

      // Total: 26 + 2 (UDL) + 24 (UD) = 52 hex chars
      expect(pdu.length).toBe(52)
    })

    it('handles odd-length national number', () => {
      const [segment] = encodePduSubmit('12345', 'A')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment

      // DA length: 05 (5 digits)
      expect(pdu.slice(6, 8)).toBe('05')

      // DA type: 81 (unknown/national, no '+' prefix)
      expect(pdu.slice(8, 10)).toBe('81')

      // BCD: 12345 -> 12345F -> nibble swap -> 2143F5
      expect(pdu.slice(10, 16)).toBe('2143F5')
    })

    it('accepts exactly 70 UCS-2 characters as single segment', () => {
      const maxText = 'A'.repeat(70)
      const segments = encodePduSubmit('+1234567890', maxText)
      expect(segments).toHaveLength(1)
      const [segment] = segments
      if (segment === undefined) throw new Error('expected one segment')
      expect(segment.pdu.length).toBeGreaterThan(0)
    })

    it('TPDU length excludes SCA', () => {
      const [segment] = encodePduSubmit('+1234567890', 'X')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu, length } = segment

      // SCA is always 1 octet (0x00), so TPDU length = total octets - 1
      const totalOctets = pdu.length / 2
      expect(length).toBe(totalOctets - 1)
    })

    it('encodes Chinese text', () => {
      // U+4F60 U+597D = 2 chars, 4 octets
      const [segment] = encodePduSubmit('+8613800138000', '\u4F60\u597D')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment
      expect(pdu).toContain('4F60597D')
    })

    it('encodes Armenian text', () => {
      // U+0532 U+0561 U+0580 U+0565 U+0582 = 5 chars, 10 octets
      const [segment] = encodePduSubmit('+37491234567', '\u0532\u0561\u0580\u0565\u0582')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment
      expect(pdu).toContain('05320561058005650582')
    })

    it('encodes Persian text', () => {
      // U+0633 U+0644 U+0627 U+0645 = "salam", 4 chars, 8 octets
      const [segment] = encodePduSubmit('+989121234567', '\u0633\u0644\u0627\u0645')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment
      expect(pdu).toContain('0633064406270645')
    })

    it('encodes Hebrew text', () => {
      // U+05E9 U+05DC U+05D5 U+05DD = "shalom", 4 chars, 8 octets
      const [segment] = encodePduSubmit('+972501234567', '\u05E9\u05DC\u05D5\u05DD')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment
      expect(pdu).toContain('05E905DC05D505DD')
    })

    it('encodes emoji as UTF-16 surrogate pair', () => {
      // U+1F44D (thumbs up) = surrogate pair D83D DC4D in UTF-16
      const [segment] = encodePduSubmit('+1234567890', '\u{1F44D}')
      if (segment === undefined) throw new Error('expected one segment')
      const { pdu } = segment
      expect(pdu).toContain('D83DDC4D')
    })
  })

  describe('concatenated segments (> 70 chars)', () => {
    it('splits 71-char message into 2 segments', () => {
      const text = 'A'.repeat(71)
      const segments = encodePduSubmit('+1234567890', text)
      expect(segments).toHaveLength(2)
    })

    it('sets UDHI bit in PDU type for concatenated segments', () => {
      const text = 'A'.repeat(71)
      const segments = encodePduSubmit('+1234567890', text)

      // PDU type byte: 0x41 = SMS-SUBMIT + UDHI
      for (const segment of segments) {
        expect(segment.pdu.slice(2, 4)).toBe('41')
      }
    })

    it('includes correct UDH with concatenation IE', () => {
      const text = 'A'.repeat(71)
      const segments = encodePduSubmit('+1234567890', text)

      // UDH starts after SCA(2) + PDU(2) + MR(2) + DA(24) + PID(2) + DCS(2) + UDL(2) = 36
      // DA for +1234567890: len(2) + type(2) + BCD(10) = 14 hex chars
      // Header: SCA(2) + PDU(2) + MR(2) + DA(14) + PID(2) + DCS(2) + UDL(2) = 26
      const udhStart = 26

      const [seg1, seg2] = segments
      if (seg1 === undefined || seg2 === undefined) throw new Error('expected two segments')

      // UDH length: 05
      expect(seg1.pdu.slice(udhStart, udhStart + 2)).toBe('05')
      // IEI: 00 (concatenated short messages, 8-bit ref)
      expect(seg1.pdu.slice(udhStart + 2, udhStart + 4)).toBe('00')
      // IE data length: 03
      expect(seg1.pdu.slice(udhStart + 4, udhStart + 6)).toBe('03')
      // Reference number: same in both segments
      const ref1 = seg1.pdu.slice(udhStart + 6, udhStart + 8)
      const ref2 = seg2.pdu.slice(udhStart + 6, udhStart + 8)
      expect(ref1).toBe(ref2)
      // Total parts: 02
      expect(seg1.pdu.slice(udhStart + 8, udhStart + 10)).toBe('02')
      expect(seg2.pdu.slice(udhStart + 8, udhStart + 10)).toBe('02')
      // Part numbers: 01, 02
      expect(seg1.pdu.slice(udhStart + 10, udhStart + 12)).toBe('01')
      expect(seg2.pdu.slice(udhStart + 10, udhStart + 12)).toBe('02')
    })

    it('splits text at 67-char boundaries (140 - 6 UDH = 134 octets = 67 chars)', () => {
      const text = 'A'.repeat(134) // 67 * 2 = exactly 2 full segments
      const segments = encodePduSubmit('+1234567890', text)
      expect(segments).toHaveLength(2)
    })

    it('creates 3 segments for 135 chars', () => {
      const text = 'A'.repeat(135) // 67 + 67 + 1
      const segments = encodePduSubmit('+1234567890', text)
      expect(segments).toHaveLength(3)
    })

    it('UDL includes UDH octets + user data octets', () => {
      const text = 'A'.repeat(71)
      const segments = encodePduSubmit('+1234567890', text)

      const udhOctets = 6
      const [seg1, seg2] = segments
      if (seg1 === undefined || seg2 === undefined) throw new Error('expected two segments')

      // First segment: 67 chars * 2 octets + 6 UDH = 140 octets
      const udlOffset = 24 // position of UDL byte in hex string
      const seg1Udl = Number.parseInt(seg1.pdu.slice(udlOffset, udlOffset + 2), 16)
      expect(seg1Udl).toBe(udhOctets + 67 * 2)

      // Second segment: 4 chars * 2 octets + 6 UDH = 14 octets
      const seg2Udl = Number.parseInt(seg2.pdu.slice(udlOffset, udlOffset + 2), 16)
      expect(seg2Udl).toBe(udhOctets + 4 * 2)
    })

    it('does not split surrogate pairs across segments', () => {
      // 66 BMP chars + emoji (2 code units) + 4 BMP chars = 72 code units > 70
      // Concat limit per segment is 67. The emoji sits at positions 66-67.
      // With 66 chars used, only 1 slot remains in segment 1 — not enough
      // for the 2-unit surrogate pair. So segment 1 gets 66 'A' chars,
      // segment 2 gets emoji + 'BBBB'.
      const text = `${'A'.repeat(66)}\u{1F44D}BBBB`
      const segments = encodePduSubmit('+1234567890', text)
      expect(segments).toHaveLength(2)

      // Segment 1 should have 66 chars (not 67) because emoji doesn't fit
      // Segment 2 must contain the intact surrogate pair
      const [, seg2] = segments
      if (seg2 === undefined) throw new Error('expected second segment')
      expect(seg2.pdu).toContain('D83DDC4D')
    })

    it('increments reference number across calls', () => {
      const text = 'A'.repeat(71)

      const [segment1] = encodePduSubmit('+1234567890', text)
      const [segment2] = encodePduSubmit('+1234567890', text)
      if (segment1 === undefined || segment2 === undefined)
        throw new Error('expected one segment per call')

      const udhRefOffset = 32 // UDH ref byte position
      const ref1 = segment1.pdu.slice(udhRefOffset, udhRefOffset + 2)
      const ref2 = segment2.pdu.slice(udhRefOffset, udhRefOffset + 2)

      expect(ref1).not.toBe(ref2)
    })

    it('TPDU length excludes SCA for each segment', () => {
      const text = 'A'.repeat(71)
      const segments = encodePduSubmit('+1234567890', text)

      for (const segment of segments) {
        const totalOctets = segment.pdu.length / 2
        expect(segment.length).toBe(totalOctets - 1)
      }
    })
  })
})
