import { describe, expect, it } from 'vitest'
import { parseLine } from '../../../../src/protocols/at/channel/parser.js'
import type { ParserContext } from '../../../../src/protocols/at/types.js'

const URC_PREFIXES = new Set([
  '+CMTI',
  '+CREG',
  '+CGREG',
  '+CEREG',
  'RING',
  'NO CARRIER',
  'BUSY',
  '+CLIP',
  '+CUSD',
])

function ctx(currentCommand: string | null = null): ParserContext {
  return { currentCommand, urcPrefixes: URC_PREFIXES }
}

describe('parseLine', () => {
  describe('empty lines', () => {
    it('classifies empty string as empty', () => {
      expect(parseLine('', ctx())).toEqual({ type: 'empty' })
    })
  })

  describe('echo', () => {
    it('detects echo of current command', () => {
      const result = parseLine('AT+CSQ', ctx('AT+CSQ'))
      expect(result).toEqual({ type: 'echo', raw: 'AT+CSQ' })
    })

    it('does not match echo when no command in flight', () => {
      const result = parseLine('AT+CSQ', ctx(null))
      expect(result.type).not.toBe('echo')
    })
  })

  describe('final result codes', () => {
    it('classifies OK', () => {
      const result = parseLine('OK', ctx('AT'))
      expect(result).toEqual({ type: 'final_result', result: { type: 'ok' }, raw: 'OK' })
    })

    it('classifies ERROR', () => {
      const result = parseLine('ERROR', ctx('AT+INVALID'))
      expect(result).toEqual({ type: 'final_result', result: { type: 'error' }, raw: 'ERROR' })
    })

    it('classifies Huawei COMMAND NOT SUPPORT as error', () => {
      const result = parseLine('COMMAND NOT SUPPORT', ctx('AT^DSCI=1'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'error' },
        raw: 'COMMAND NOT SUPPORT',
      })
    })

    it('classifies +CME ERROR with numeric code and resolves message', () => {
      const result = parseLine('+CME ERROR: 10', ctx('AT+CPIN?'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'cme_error', code: 10, message: 'SIM not inserted' },
        raw: '+CME ERROR: 10',
      })
    })

    it('classifies +CME ERROR with unknown numeric code', () => {
      const result = parseLine('+CME ERROR: 9999', ctx('AT+CPIN?'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'cme_error', code: 9999, message: 'error 9999' },
        raw: '+CME ERROR: 9999',
      })
    })

    it('classifies +CME ERROR with verbose message', () => {
      const result = parseLine('+CME ERROR: SIM not inserted', ctx('AT+CPIN?'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'cme_error', code: -1, message: 'SIM not inserted' },
        raw: '+CME ERROR: SIM not inserted',
      })
    })

    it('classifies +CMS ERROR with numeric code and resolves message', () => {
      const result = parseLine('+CMS ERROR: 305', ctx('AT+CMGS'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'cms_error', code: 305, message: 'Invalid text mode parameter' },
        raw: '+CMS ERROR: 305',
      })
    })
  })

  describe('NO CARRIER ambiguity', () => {
    it('is final result during ATD (dial)', () => {
      const result = parseLine('NO CARRIER', ctx('ATD+1234567890;'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'no_carrier' },
        raw: 'NO CARRIER',
      })
    })

    it('is URC when no command in flight', () => {
      const result = parseLine('NO CARRIER', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: 'NO CARRIER',
        body: '',
        raw: 'NO CARRIER',
      })
    })

    it('is URC when non-dial command in flight', () => {
      const result = parseLine('NO CARRIER', ctx('AT+CSQ'))
      expect(result).toEqual({
        type: 'urc',
        prefix: 'NO CARRIER',
        body: '',
        raw: 'NO CARRIER',
      })
    })
  })

  describe('BUSY ambiguity', () => {
    it('is final result during ATD', () => {
      const result = parseLine('BUSY', ctx('ATD123;'))
      expect(result).toEqual({
        type: 'final_result',
        result: { type: 'busy' },
        raw: 'BUSY',
      })
    })

    it('is URC when registered and not dialing', () => {
      const result = parseLine('BUSY', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: 'BUSY',
        body: '',
        raw: 'BUSY',
      })
    })
  })

  describe('URCs', () => {
    it('classifies known URC with colon', () => {
      const result = parseLine('+CMTI: "SM",3', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: '+CMTI',
        body: '"SM",3',
        raw: '+CMTI: "SM",3',
      })
    })

    it('classifies RING (prefix-only, no colon)', () => {
      const result = parseLine('RING', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: 'RING',
        body: '',
        raw: 'RING',
      })
    })

    it('classifies known URC during a command (interleaving)', () => {
      const result = parseLine('+CMTI: "SM",3', ctx('AT+CSQ'))
      expect(result).toEqual({
        type: 'urc',
        prefix: '+CMTI',
        body: '"SM",3',
        raw: '+CMTI: "SM",3',
      })
    })

    it('classifies +CREG URC', () => {
      const result = parseLine('+CREG: 1,"00A1","1A2B"', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: '+CREG',
        body: '1,"00A1","1A2B"',
        raw: '+CREG: 1,"00A1","1A2B"',
      })
    })
  })

  describe('info responses', () => {
    it('classifies +CSQ response during AT+CSQ command', () => {
      // +CSQ is NOT in the URC prefixes, so during a command it's an info response
      const result = parseLine('+CSQ: 18,99', ctx('AT+CSQ'))
      expect(result).toEqual({
        type: 'info_response',
        raw: '+CSQ: 18,99',
      })
    })

    it('classifies unknown line during command as info response', () => {
      const result = parseLine('some random data', ctx('AT+SOMETHING'))
      expect(result).toEqual({
        type: 'info_response',
        raw: 'some random data',
      })
    })
  })

  describe('vendor ^ prefix (Huawei)', () => {
    const huaweiPrefixes = new Set([...URC_PREFIXES, '^HCSQ', '^MODE', '^RSSI', '^DSFLOWRPT'])

    function huaweiCtx(cmd: string | null = null): ParserContext {
      return { currentCommand: cmd, urcPrefixes: huaweiPrefixes }
    }

    it('classifies ^HCSQ as URC when idle', () => {
      const result = parseLine('^HCSQ: "LTE",51,45,120,18', huaweiCtx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: '^HCSQ',
        body: '"LTE",51,45,120,18',
        raw: '^HCSQ: "LTE",51,45,120,18',
      })
    })

    it('classifies ^HCSQ as info_response during AT^HCSQ command', () => {
      const result = parseLine('^HCSQ: "LTE",51,45,120,18', huaweiCtx('AT^HCSQ'))
      expect(result).toEqual({
        type: 'info_response',
        raw: '^HCSQ: "LTE",51,45,120,18',
      })
    })

    it('classifies ^HCSQ as URC during unrelated command', () => {
      const result = parseLine('^HCSQ: "LTE",51,45,120,18', huaweiCtx('AT+CSQ'))
      expect(result).toEqual({
        type: 'urc',
        prefix: '^HCSQ',
        body: '"LTE",51,45,120,18',
        raw: '^HCSQ: "LTE",51,45,120,18',
      })
    })

    it('classifies ^DSFLOWRPT as URC', () => {
      const result = parseLine('^DSFLOWRPT: 0,0,0,0,0,0,0', huaweiCtx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: '^DSFLOWRPT',
        body: '0,0,0,0,0,0,0',
        raw: '^DSFLOWRPT: 0,0,0,0,0,0,0',
      })
    })
  })

  describe('unknown lines while idle', () => {
    it('extracts prefix from +PREFIX: lines', () => {
      const result = parseLine('+UNKNOWN: data', ctx(null))
      expect(result).toEqual({
        type: 'urc',
        prefix: '+UNKNOWN',
        body: 'data',
        raw: '+UNKNOWN: data',
      })
    })

    it('treats truly unknown lines as info_response', () => {
      const result = parseLine('garbage', ctx(null))
      expect(result).toEqual({
        type: 'info_response',
        raw: 'garbage',
      })
    })
  })
})
