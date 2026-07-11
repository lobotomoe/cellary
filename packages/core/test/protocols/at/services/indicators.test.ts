import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { DeviceModule } from '../../../../src/protocols/at/services/device.js'
import { MockTransport } from '../../../../src/transport/mock.js'
import type { AtConfig } from '../../../../src/types.js'

const baseProfile: AtConfig = {
  initCommands: [],
  urcPrefixes: [],
}

function createModule(): { transport: MockTransport; channel: ATChannel; device: DeviceModule } {
  const transport = new MockTransport()
  const channel = new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
  const device = new DeviceModule(channel, baseProfile)
  return { transport, channel, device }
}

describe('DeviceModule -- indicators', () => {
  let transport: MockTransport
  let channel: ATChannel
  let device: DeviceModule

  beforeEach(async () => {
    ;({ transport, channel, device } = createModule())
    await transport.open()
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── indicators() ──────────────────────────────────────────────────────

  describe('indicators()', () => {
    it('parses descriptors and values from a typical modem', async () => {
      transport.autoRespond({
        'AT+CIND=?\r':
          '\r\n+CIND: ("battchg",(0-5)),("signal",(0-5)),("service",(0-1)),("message",(0-1)),("call",(0-1)),("roam",(0-1))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 4,3,1,0,0,0\r\n\r\nOK\r\n',
      })

      const report = await device.indicators()

      expect(report.descriptors).toHaveLength(6)
      expect(report.descriptors[0]).toEqual({ name: 'battchg', min: 0, max: 5 })
      expect(report.descriptors[1]).toEqual({ name: 'signal', min: 0, max: 5 })
      expect(report.descriptors[2]).toEqual({ name: 'service', min: 0, max: 1 })

      expect(report.values).toEqual({
        battchg: 4,
        signal: 3,
        service: 1,
        message: 0,
        call: 0,
        roam: 0,
      })
    })

    it('caches descriptors across multiple calls', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5)),("service",(0-1))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 4,1\r\n\r\nOK\r\n',
      })

      await device.indicators()
      await device.indicators()

      // AT+CIND=? should only be sent once (descriptors cached)
      const testCommands = transport.written.filter((cmd) => cmd === 'AT+CIND=?\r')
      expect(testCommands).toHaveLength(1)

      // AT+CIND? should be sent twice (values are always fresh)
      const readCommands = transport.written.filter((cmd) => cmd === 'AT+CIND?\r')
      expect(readCommands).toHaveLength(2)
    })

    it('handles modem with single indicator', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 3\r\n\r\nOK\r\n',
      })

      const report = await device.indicators()
      expect(report.descriptors).toHaveLength(1)
      expect(report.values).toEqual({ signal: 3 })
    })

    it('throws ParseError when AT+CIND? returns no data', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\nOK\r\n',
      })

      await expect(device.indicators()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed AT+CIND? response', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(device.indicators()).rejects.toThrow('Failed to parse')
    })

    it('handles more values than descriptors gracefully', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 3,1,0\r\n\r\nOK\r\n',
      })

      const report = await device.indicators()
      // Should only include the first value (matched to the one descriptor)
      expect(report.values).toEqual({ signal: 3 })
    })

    it('handles fewer values than descriptors gracefully', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5)),("service",(0-1)),("roam",(0-1))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 3\r\n\r\nOK\r\n',
      })

      const report = await device.indicators()
      expect(report.values).toEqual({ signal: 3 })
    })
  })

  // ── resolveIndicatorName() ────────────────────────────────────────────

  describe('resolveIndicatorName()', () => {
    it('returns undefined before descriptors are loaded', () => {
      expect(device.resolveIndicatorName(1)).toBeUndefined()
    })

    it('resolves 1-based index after indicators() call', async () => {
      transport.autoRespond({
        'AT+CIND=?\r':
          '\r\n+CIND: ("battchg",(0-5)),("signal",(0-5)),("service",(0-1))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 4,3,1\r\n\r\nOK\r\n',
      })

      await device.indicators()

      expect(device.resolveIndicatorName(1)).toBe('battchg')
      expect(device.resolveIndicatorName(2)).toBe('signal')
      expect(device.resolveIndicatorName(3)).toBe('service')
    })

    it('returns undefined for out-of-range index', async () => {
      transport.autoRespond({
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 3\r\n\r\nOK\r\n',
      })

      await device.indicators()

      expect(device.resolveIndicatorName(0)).toBeUndefined()
      expect(device.resolveIndicatorName(2)).toBeUndefined()
      expect(device.resolveIndicatorName(99)).toBeUndefined()
    })
  })
})
