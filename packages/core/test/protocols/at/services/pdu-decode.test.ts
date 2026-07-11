import { describe, expect, it } from 'vitest'
import { decodePduDeliver } from '../../../../src/protocols/at/services/sms/pdu-decode.js'

describe('decodePduDeliver()', () => {
  describe('GSM 7-bit encoding', () => {
    it('decodes a simple GSM 7-bit message', () => {
      // "Hello world" from +1234567890, timestamp 24/03/01 12:30:00 +02:00
      const pdu = '00000A9121436587090000423010210300800BC8329BFD06DDDF723619'
      const result = decodePduDeliver(pdu)

      expect(result.sender).toBe('+1234567890')
      expect(result.text).toBe('Hello world')
      expect(result.encoding).toBe('gsm7')
      expect(result.concat).toBeUndefined()
    })

    it('decodes short GSM 7-bit message', () => {
      // "Test msg" from +5551234
      const pdu = '00000791551532F400005210519000000008D4F29C0E6ACFCF'
      const result = decodePduDeliver(pdu)

      expect(result.sender).toBe('+5551234')
      expect(result.text).toBe('Test msg')
      expect(result.encoding).toBe('gsm7')
    })

    it('decodes timestamp correctly', () => {
      // Timestamp: 24/03/01 12:30:00 TZ+08 (= +2 hours UTC)
      // Local 12:30 in UTC+2 = 10:30 UTC
      const pdu = '00000A9121436587090000423010210300800BC8329BFD06DDDF723619'
      const result = decodePduDeliver(pdu)

      expect(result.timestamp.getUTCHours()).toBe(10)
      expect(result.timestamp.getUTCMinutes()).toBe(30)
      expect(result.timestamp.getUTCFullYear()).toBe(2024)
      expect(result.timestamp.getUTCMonth()).toBe(2) // March (0-based)
      expect(result.timestamp.getUTCDate()).toBe(1)
    })
  })

  describe('UCS-2 encoding', () => {
    it('decodes Cyrillic UCS-2 message', () => {
      // "Привет" from +79001234567
      const pdu = '00000B919700214365F70008426051010300210C041F04400438043204350442'
      const result = decodePduDeliver(pdu)

      expect(result.sender).toBe('+79001234567')
      expect(result.text).toBe('\u041F\u0440\u0438\u0432\u0435\u0442')
      expect(result.encoding).toBe('ucs2')
      expect(result.concat).toBeUndefined()
    })
  })

  describe('multipart concatenation (UCS-2)', () => {
    const PDU_PART1 =
      '00400B919700214365F70008521051900000002A0500032A0201' +
      '00500061007200740020006F006E00650020007400650078007400200068006500720065'
    const PDU_PART2 =
      '00400B919700214365F70008521051900000001A0500032A0202' +
      '00200063006F006E00740069006E007500650073'

    it('extracts concat info from part 1', () => {
      const result = decodePduDeliver(PDU_PART1)

      expect(result.sender).toBe('+79001234567')
      expect(result.text).toBe('Part one text here')
      expect(result.concat).toEqual({ reference: 42, totalParts: 2, partNumber: 1 })
    })

    it('extracts concat info from part 2', () => {
      const result = decodePduDeliver(PDU_PART2)

      expect(result.sender).toBe('+79001234567')
      expect(result.text).toBe(' continues')
      expect(result.concat).toEqual({ reference: 42, totalParts: 2, partNumber: 2 })
    })
  })

  describe('multipart concatenation (GSM 7-bit)', () => {
    const PDU_PART1 = '00400A912143658709000052300141000080110500030702018C69F99C0E8287E574'
    const PDU_PART2 = '00400A9121436587090000523001410000801305000307020240F3F2F8ED2683E061391D'

    it('decodes GSM 7-bit part 1 with UDH', () => {
      const result = decodePduDeliver(PDU_PART1)

      expect(result.sender).toBe('+1234567890')
      expect(result.text).toBe('First part')
      expect(result.encoding).toBe('gsm7')
      expect(result.concat).toEqual({ reference: 7, totalParts: 2, partNumber: 1 })
    })

    it('decodes GSM 7-bit part 2 with UDH', () => {
      const result = decodePduDeliver(PDU_PART2)

      expect(result.sender).toBe('+1234567890')
      expect(result.text).toBe(' second part')
      expect(result.encoding).toBe('gsm7')
      expect(result.concat).toEqual({ reference: 7, totalParts: 2, partNumber: 2 })
    })
  })

  describe('error handling', () => {
    it('throws on non-DELIVER PDU type', () => {
      // Change MTI to 01 (SMS-SUBMIT) -- byte at position 2-3 after SCA
      const pdu = '00010A9121436587090000423010210300800BC8329BFD06DDDF723619'
      expect(() => decodePduDeliver(pdu)).toThrow('Expected SMS-DELIVER')
    })

    it('throws on truncated PDU', () => {
      expect(() => decodePduDeliver('0000')).toThrow('unexpected end of data')
    })
  })
})
