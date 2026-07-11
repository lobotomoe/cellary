import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  extractHiLinkErrorCode,
  HiLinkApiError,
  parseHiLinkXml,
  parseXmlRaw,
} from '../../../../src/vendor/huawei/protocols/hilink/xml.js'

describe('parseHiLinkXml', () => {
  const signalSchema = z.object({
    rssi: z.number().optional(),
    mode: z.number().optional(),
  })

  it('parses a valid response', () => {
    const xml = '<response><rssi>-67</rssi><mode>7</mode></response>'
    const data = parseHiLinkXml(xml, signalSchema)
    expect(data).toEqual({ rssi: -67, mode: 7 })
  })

  it('parses response with missing optional fields', () => {
    const xml = '<response><rssi>-80</rssi></response>'
    const data = parseHiLinkXml(xml, signalSchema)
    expect(data).toEqual({ rssi: -80 })
  })

  it('throws HiLinkApiError for error responses', () => {
    const xml = '<error><code>100003</code><message>auth required</message></error>'
    expect(() => parseHiLinkXml(xml, signalSchema)).toThrow(HiLinkApiError)
    try {
      parseHiLinkXml(xml, signalSchema)
    } catch (err) {
      if (!(err instanceof HiLinkApiError)) throw err
      expect(err.code).toBe('100003')
      expect(err.message).toContain('Authentication required')
    }
  })

  it('throws HiLinkApiError for numeric error codes', () => {
    const xml = '<error><code>125002</code></error>'
    try {
      parseHiLinkXml(xml, signalSchema)
    } catch (err) {
      if (!(err instanceof HiLinkApiError)) throw err
      expect(err.code).toBe('125002')
      expect(err.message).toContain('firmware policy')
    }
  })

  it('handles response without wrapper', () => {
    const schema = z.object({ value: z.number() })
    const xml = '<value>42</value>'
    const data = parseHiLinkXml(xml, schema)
    expect(data).toEqual({ value: 42 })
  })
})

describe('extractHiLinkErrorCode', () => {
  it('returns error code from error response', () => {
    const xml = '<error><code>100003</code><message>auth</message></error>'
    expect(extractHiLinkErrorCode(xml)).toBe('100003')
  })

  it('returns undefined for success response', () => {
    const xml = '<response>OK</response>'
    expect(extractHiLinkErrorCode(xml)).toBeUndefined()
  })

  it('handles numeric error codes', () => {
    const xml = '<error><code>108006</code></error>'
    expect(extractHiLinkErrorCode(xml)).toBe('108006')
  })

  it('returns undefined for non-XML content', () => {
    expect(extractHiLinkErrorCode('not xml')).toBeUndefined()
  })
})

/** Extract a nested record from a raw XML parse result. */
function extractRecord(parsed: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parsed[key]
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected object at key '${key}', got ${typeof value}`)
  }
  return value
}

describe('parseXmlRaw', () => {
  it('parses session token response', () => {
    const xml =
      '<response><SesInfo>SessionID=abc123</SesInfo><TokInfo>token456</TokInfo></response>'
    const parsed = parseXmlRaw(xml)
    const response = extractRecord(parsed, 'response')
    expect(response.SesInfo).toBe('SessionID=abc123')
    expect(response.TokInfo).toBe('token456')
  })

  it('parses dev_info.data config response', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<config>',
      '<chiptemp>376</chiptemp>',
      '<uptime>45542</uptime>',
      '<rssi>-74</rssi>',
      '<band>3</band>',
      '<DeviceName>E8372H-153</DeviceName>',
      '</config>',
    ].join('')
    const parsed = parseXmlRaw(xml)
    const config = extractRecord(parsed, 'config')
    expect(config.chiptemp).toBe(376)
    expect(config.uptime).toBe(45542)
    expect(config.rssi).toBe(-74)
    expect(config.band).toBe(3)
    expect(config.DeviceName).toBe('E8372H-153')
  })

  it('parses numeric strings as numbers', () => {
    const xml = '<response><rssi>-67</rssi></response>'
    const parsed = parseXmlRaw(xml)
    const response = extractRecord(parsed, 'response')
    expect(response.rssi).toBe(-67)
  })
})
