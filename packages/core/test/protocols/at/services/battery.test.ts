import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DeviceModule } from '../../../../src/protocols/at/services/device.js'
import { MockTransport } from '../../../../src/transport/mock.js'

function createModule(): { transport: MockTransport; channel: ATChannel; device: DeviceModule } {
  const transport = new MockTransport()
  const channel = new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
  const device = new DeviceModule(channel, genericProfile.at)
  return { transport, channel, device }
}

describe('DeviceModule -- battery', () => {
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

  describe('battery()', () => {
    it('parses battery powered with charge level', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\n+CBC: 0,85\r\n\r\nOK\r\n',
      })

      const info = await device.battery()
      expect(info.status).toBe('batteryPowered')
      expect(info.chargeLevel).toBe(85)
    })

    it('parses battery connected (not powering)', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\n+CBC: 1,100\r\n\r\nOK\r\n',
      })

      const info = await device.battery()
      expect(info.status).toBe('batteryConnected')
      expect(info.chargeLevel).toBe(100)
    })

    it('parses no battery', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\n+CBC: 2,0\r\n\r\nOK\r\n',
      })

      const info = await device.battery()
      expect(info.status).toBe('noBattery')
      expect(info.chargeLevel).toBe(0)
    })

    it('parses power fault', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\n+CBC: 3,0\r\n\r\nOK\r\n',
      })

      const info = await device.battery()
      expect(info.status).toBe('powerFault')
      expect(info.chargeLevel).toBe(0)
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\nOK\r\n',
      })

      await expect(device.battery()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(device.battery()).rejects.toThrow('Failed to parse')
    })

    it('throws ParseError on unknown status code', async () => {
      transport.autoRespond({
        'AT+CBC\r': '\r\n+CBC: 9,50\r\n\r\nOK\r\n',
      })

      await expect(device.battery()).rejects.toThrow('Unknown battery status code')
    })
  })
})
