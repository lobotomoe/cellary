import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DeviceModule } from '../../../../src/protocols/at/services/device.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

describe('DeviceModule -- clock', () => {
  let transport: MockTransport
  let channel: ATChannel
  let device: DeviceModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    device = new DeviceModule(channel, atConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('clock()', () => {
    it('parses date/time with timezone offset', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\n+CCLK: "14/08/05,04:00:21+40"\r\n\r\nOK\r\n',
      })

      const info = await device.clock()
      // +40 quarters = +600 minutes = +10 hours. Local 04:00:21 -> UTC 18:00:21 (previous day Aug 4)
      expect(info.dateTime.getUTCFullYear()).toBe(2014)
      expect(info.dateTime.getUTCMonth()).toBe(7) // August = 7
      expect(info.dateTime.getUTCDate()).toBe(4)
      expect(info.dateTime.getUTCHours()).toBe(18)
      expect(info.dateTime.getUTCMinutes()).toBe(0)
      expect(info.dateTime.getUTCSeconds()).toBe(21)
      expect(info.timezoneOffsetMinutes).toBe(600) // 40 * 15
    })

    it('parses date/time with negative timezone offset', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\n+CCLK: "15/02/28,20:30:40-32"\r\n\r\nOK\r\n',
      })

      const info = await device.clock()
      // -32 quarters = -480 minutes = -8 hours
      expect(info.dateTime.getUTCFullYear()).toBe(2015)
      expect(info.dateTime.getUTCMonth()).toBe(2) // March
      expect(info.dateTime.getUTCDate()).toBe(1)
      expect(info.dateTime.getUTCHours()).toBe(4)
      expect(info.dateTime.getUTCMinutes()).toBe(30)
      expect(info.dateTime.getUTCSeconds()).toBe(40)
      expect(info.timezoneOffsetMinutes).toBe(-480) // -32 * 15
    })

    it('parses date/time without timezone', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\n+CCLK: "14/08/05,04:00:21"\r\n\r\nOK\r\n',
      })

      const info = await device.clock()
      expect(info.dateTime.getUTCFullYear()).toBe(2014)
      expect(info.dateTime.getUTCMonth()).toBe(7)
      expect(info.dateTime.getUTCDate()).toBe(5)
      expect(info.dateTime.getUTCHours()).toBe(4)
      expect(info.timezoneOffsetMinutes).toBeUndefined()
    })

    it('parses unquoted response', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\n+CCLK: 17/07/26,11:42:15+01\r\n\r\nOK\r\n',
      })

      const info = await device.clock()
      expect(info.dateTime.getUTCFullYear()).toBe(2017)
      expect(info.dateTime.getUTCMonth()).toBe(6)
      expect(info.dateTime.getUTCDate()).toBe(26)
      // +1 quarter = +15 minutes. 11:42:15 local -> 11:27:15 UTC
      expect(info.dateTime.getUTCHours()).toBe(11)
      expect(info.dateTime.getUTCMinutes()).toBe(27)
      expect(info.timezoneOffsetMinutes).toBe(15) // 1 * 15
    })

    it('parses 4-digit year format', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\n+CCLK: "2024/12/25,18:30:00+16"\r\n\r\nOK\r\n',
      })

      const info = await device.clock()
      expect(info.dateTime.getUTCFullYear()).toBe(2024)
      expect(info.dateTime.getUTCMonth()).toBe(11)
      expect(info.dateTime.getUTCDate()).toBe(25)
      // +16 quarters = +240 minutes = +4 hours. 18:30 local -> 14:30 UTC
      expect(info.dateTime.getUTCHours()).toBe(14)
      expect(info.timezoneOffsetMinutes).toBe(240) // 16 * 15
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\nOK\r\n',
      })

      await expect(device.clock()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CCLK?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(device.clock()).rejects.toThrow('Failed to parse')
    })
  })

  describe('setClock()', () => {
    it('formats date/time without timezone', async () => {
      transport.autoRespond({
        'AT+CCLK="24/12/25,14:30:00"\r': '\r\nOK\r\n',
      })

      const date = new Date(Date.UTC(2024, 11, 25, 14, 30, 0))
      await device.setClock(date)
    })

    it('formats date/time with positive timezone (minutes -> quarter-hours)', async () => {
      transport.autoRespond({
        'AT+CCLK="24/01/01,00:00:00+08"\r': '\r\nOK\r\n',
      })

      const date = new Date(Date.UTC(2024, 0, 1, 0, 0, 0))
      await device.setClock(date, 120) // 120 min = 8 quarter-hours
    })

    it('formats date/time with negative timezone (minutes -> quarter-hours)', async () => {
      transport.autoRespond({
        'AT+CCLK="24/06/15,12:00:00-32"\r': '\r\nOK\r\n',
      })

      const date = new Date(Date.UTC(2024, 5, 15, 12, 0, 0))
      await device.setClock(date, -480) // -480 min = -32 quarter-hours
    })

    it('pads single-digit values', async () => {
      transport.autoRespond({
        'AT+CCLK="24/03/05,09:05:03"\r': '\r\nOK\r\n',
      })

      const date = new Date(Date.UTC(2024, 2, 5, 9, 5, 3))
      await device.setClock(date)
    })
  })

  describe('setAutoTimezone()', () => {
    it('enables automatic timezone update', async () => {
      transport.autoRespond({
        'AT+CTZU=1\r': '\r\nOK\r\n',
      })

      await device.setAutoTimezone(true)
    })

    it('disables automatic timezone update', async () => {
      transport.autoRespond({
        'AT+CTZU=0\r': '\r\nOK\r\n',
      })

      await device.setAutoTimezone(false)
    })
  })
})
