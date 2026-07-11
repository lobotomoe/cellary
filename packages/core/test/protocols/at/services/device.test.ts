import { describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { DeviceModule } from '../../../../src/protocols/at/services/device.js'
import { MockTransport } from '../../../../src/transport/mock.js'
import type { AtConfig } from '../../../../src/types.js'

function createChannel(transport: MockTransport): ATChannel {
  return new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
}

const baseProfile: AtConfig = {
  initCommands: [],
  urcPrefixes: [],
}

describe('DeviceModule', () => {
  describe('temperature()', () => {
    it('returns undefined when profile has no chipTemp command', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const device = new DeviceModule(channel, baseProfile)

      const temp = await device.temperature()
      expect(temp).toBeUndefined()
    })

    it('parses Huawei ^CHIPTEMP response', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const profile: AtConfig = {
        ...baseProfile,
        commands: { chipTemp: 'AT^CHIPTEMP?' },
      }
      const device = new DeviceModule(channel, profile)

      transport.autoRespond({
        'AT^CHIPTEMP?\r': '\r\n^CHIPTEMP: 34,31,21,42,10000\r\n\r\nOK\r\n',
      })
      await transport.open()

      const temp = await device.temperature()
      // Should pick the highest value in 5-120 range: 42
      expect(temp).toBe(42)
    })

    it('filters out threshold values above 120', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const profile: AtConfig = {
        ...baseProfile,
        commands: { chipTemp: 'AT^CHIPTEMP?' },
      }
      const device = new DeviceModule(channel, profile)

      transport.autoRespond({
        'AT^CHIPTEMP?\r': '\r\n^CHIPTEMP: 35,10000\r\n\r\nOK\r\n',
      })
      await transport.open()

      const temp = await device.temperature()
      expect(temp).toBe(35)
    })

    it('returns undefined on AT error', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const profile: AtConfig = {
        ...baseProfile,
        commands: { chipTemp: 'AT^CHIPTEMP?' },
      }
      const device = new DeviceModule(channel, profile)

      transport.autoRespond({
        'AT^CHIPTEMP?\r': '\r\nERROR\r\n',
      })
      await transport.open()

      const temp = await device.temperature()
      expect(temp).toBeUndefined()
    })

    it('returns undefined when response has no valid temperatures', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const profile: AtConfig = {
        ...baseProfile,
        commands: { chipTemp: 'AT^CHIPTEMP?' },
      }
      const device = new DeviceModule(channel, profile)

      transport.autoRespond({
        'AT^CHIPTEMP?\r': '\r\n^CHIPTEMP: 0,0,0,0,10000\r\n\r\nOK\r\n',
      })
      await transport.open()

      const temp = await device.temperature()
      expect(temp).toBeUndefined()
    })
  })
})
