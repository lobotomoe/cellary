import { describe, expect, it } from 'vitest'
import {
  decodeEdrxCycle,
  decodeGprsTimer,
  decodeGprsTimer3,
  decodePagingWindow,
  encodeEdrxCycle,
  encodeGprsTimer,
  encodeGprsTimer3,
} from '../../../../src/protocols/at/services/timer-encoding.js'

describe('GPRS Timer encoding', () => {
  describe('decodeGprsTimer()', () => {
    it('decodes unit=000 (2s multiplier)', () => {
      // 00000101 -> unit=000 (2s), value=00101 (5) -> 10s
      expect(decodeGprsTimer('00000101')).toBe(10)
    })

    it('decodes unit=001 (1min multiplier)', () => {
      // 00100100 -> unit=001 (60s), value=00100 (4) -> 240s
      expect(decodeGprsTimer('00100100')).toBe(240)
    })

    it('decodes unit=010 (6min multiplier)', () => {
      // 01000111 -> unit=010 (360s), value=00111 (7) -> 2520s
      expect(decodeGprsTimer('01000111')).toBe(2520)
    })

    it('returns undefined for deactivated (unit=111)', () => {
      expect(decodeGprsTimer('11100000')).toBeUndefined()
    })

    it('returns undefined for invalid length', () => {
      expect(decodeGprsTimer('0100')).toBeUndefined()
    })

    it('decodes zero value', () => {
      // 00000000 -> unit=000 (2s), value=0 -> 0s
      expect(decodeGprsTimer('00000000')).toBe(0)
    })

    it('decodes max value per unit', () => {
      // 00011111 -> unit=000 (2s), value=31 -> 62s
      expect(decodeGprsTimer('00011111')).toBe(62)
    })
  })

  describe('encodeGprsTimer()', () => {
    it('encodes exact 2s multiple', () => {
      // 10s -> 5 * 2s -> unit=000, value=5 -> 00000101
      expect(encodeGprsTimer(10)).toBe('00000101')
    })

    it('encodes exact 1min multiple', () => {
      // 240s -> 4 * 60s -> unit=001, value=4 -> 00100100
      expect(encodeGprsTimer(240)).toBe('00100100')
    })

    it('encodes exact 6min multiple', () => {
      // 2520s -> 7 * 360s -> unit=010, value=7 -> 01000111
      expect(encodeGprsTimer(2520)).toBe('01000111')
    })

    it('round-trips with decode', () => {
      for (const seconds of [0, 2, 60, 120, 240, 360, 2520]) {
        const encoded = encodeGprsTimer(seconds)
        expect(decodeGprsTimer(encoded)).toBe(seconds)
      }
    })
  })

  describe('decodeGprsTimer3()', () => {
    it('decodes unit=011 (2s multiplier)', () => {
      // 01100101 -> unit=011 (2s), value=00101 (5) -> 10s
      expect(decodeGprsTimer3('01100101')).toBe(10)
    })

    it('decodes unit=000 (10min multiplier)', () => {
      // 00000011 -> unit=000 (600s), value=00011 (3) -> 1800s
      expect(decodeGprsTimer3('00000011')).toBe(1800)
    })

    it('decodes unit=010 (10h multiplier)', () => {
      // 01000011 -> unit=010 (36000s), value=00011 (3) -> 108000s
      expect(decodeGprsTimer3('01000011')).toBe(108_000)
    })

    it('decodes unit=001 (1h multiplier)', () => {
      // 00100010 -> unit=001 (3600s), value=00010 (2) -> 7200s
      expect(decodeGprsTimer3('00100010')).toBe(7200)
    })

    it('returns undefined for deactivated', () => {
      expect(decodeGprsTimer3('11100000')).toBeUndefined()
    })
  })

  describe('encodeGprsTimer3()', () => {
    it('encodes exact 10min multiple', () => {
      // 1800s -> 3 * 600s -> unit=000, value=3 -> 00000011
      expect(encodeGprsTimer3(1800)).toBe('00000011')
    })

    it('encodes exact 1h multiple', () => {
      // 7200s -> 2 * 3600s -> unit=001, value=2 -> 00100010
      expect(encodeGprsTimer3(7200)).toBe('00100010')
    })

    it('encodes exact 10h multiple', () => {
      // 108000s -> 3 * 36000s -> unit=010, value=3 -> 01000011
      expect(encodeGprsTimer3(108_000)).toBe('01000011')
    })

    it('round-trips with decode', () => {
      for (const seconds of [2, 60, 600, 3600, 36_000, 108_000]) {
        const encoded = encodeGprsTimer3(seconds)
        expect(decodeGprsTimer3(encoded)).toBe(seconds)
      }
    })
  })
})

describe('eDRX cycle encoding', () => {
  describe('decodeEdrxCycle()', () => {
    it('decodes E-UTRAN WB code 0 -> 5.12s', () => {
      expect(decodeEdrxCycle('0000', 'eutranWb')).toBe(5.12)
    })

    it('decodes E-UTRAN WB code 2 -> 20.48s', () => {
      expect(decodeEdrxCycle('0010', 'eutranWb')).toBe(20.48)
    })

    it('decodes E-UTRAN NB code 14 -> 5242.88s', () => {
      expect(decodeEdrxCycle('1110', 'eutranNb')).toBe(5242.88)
    })

    it('decodes UTRAN code 5 -> 40.96s', () => {
      expect(decodeEdrxCycle('0101', 'utran')).toBe(40.96)
    })

    it('decodes GSM code 0 -> 1.88s', () => {
      expect(decodeEdrxCycle('0000', 'gsm')).toBe(1.88)
    })

    it('returns undefined for access type none', () => {
      expect(decodeEdrxCycle('0010', 'none')).toBeUndefined()
    })
  })

  describe('encodeEdrxCycle()', () => {
    it('encodes exact E-UTRAN WB value', () => {
      // 20.48s -> code 2 -> "0010"
      expect(encodeEdrxCycle(20.48, 'eutranWb')).toBe('0010')
    })

    it('encodes approximate value to nearest code', () => {
      // 20s is closest to 20.48s (code 2) for E-UTRAN WB
      expect(encodeEdrxCycle(20, 'eutranWb')).toBe('0010')
    })

    it('throws for access type none', () => {
      expect(() => encodeEdrxCycle(20, 'none')).toThrow()
    })
  })

  describe('decodePagingWindow()', () => {
    it('decodes E-UTRAN WB PTW code 9 -> 12.8s', () => {
      expect(decodePagingWindow('1001', 'eutranWb')).toBe(12.8)
    })

    it('decodes E-UTRAN NB PTW code 3 -> 10.24s', () => {
      expect(decodePagingWindow('0011', 'eutranNb')).toBe(10.24)
    })

    it('returns undefined for unsupported access type', () => {
      expect(decodePagingWindow('0011', 'utran')).toBeUndefined()
    })
  })
})
