import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { NetworkModule } from '../../../../src/protocols/at/services/network.js'
import { RadioModule } from '../../../../src/protocols/at/services/radio.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

// ── GPRS Registration ─────────────────────────────────────────────────────

describe('NetworkModule -- GPRS registration', () => {
  let transport: MockTransport
  let channel: ATChannel
  let network: NetworkModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    network = new NetworkModule(channel, atConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('gprsRegistration()', () => {
    it('parses registered home with LAC and cell ID', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\n+CGREG: 1,1,"1A2B","3C4D5E6F",7\r\n\r\nOK\r\n',
      })

      const info = await network.gprsRegistration()
      expect(info.status).toBe('home')
      expect(info.locationAreaCode).toBe('1A2B')
      expect(info.cellId).toBe('3C4D5E6F')
      expect(info.technology).toBe('LTE')
    })

    it('parses not registered status', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\n+CGREG: 1,0\r\n\r\nOK\r\n',
      })

      const info = await network.gprsRegistration()
      expect(info.status).toBe('notRegistered')
      expect(info.locationAreaCode).toBeUndefined()
    })

    it('parses roaming status', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\n+CGREG: 1,5,"ABCD","12345678"\r\n\r\nOK\r\n',
      })

      const info = await network.gprsRegistration()
      expect(info.status).toBe('roaming')
      expect(info.locationAreaCode).toBe('ABCD')
    })

    it('parses searching status', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\n+CGREG: 1,2\r\n\r\nOK\r\n',
      })

      const info = await network.gprsRegistration()
      expect(info.status).toBe('searching')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\nOK\r\n',
      })

      await expect(network.gprsRegistration()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CGREG?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(network.gprsRegistration()).rejects.toThrow('Failed to parse')
    })
  })
})

// ── Activity Status & Wireless Service ────────────────────────────────────

describe('RadioModule -- activity status & wireless service', () => {
  let transport: MockTransport
  let channel: ATChannel
  let radio: RadioModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    radio = new RadioModule(channel)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('activityStatus()', () => {
    it('parses ready status (0)', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\n+CPAS: 0\r\n\r\nOK\r\n',
      })

      const status = await radio.activityStatus()
      expect(status).toBe('ready')
    })

    it('parses ringing status (3)', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\n+CPAS: 3\r\n\r\nOK\r\n',
      })

      const status = await radio.activityStatus()
      expect(status).toBe('ringing')
    })

    it('parses call in progress status (4)', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\n+CPAS: 4\r\n\r\nOK\r\n',
      })

      const status = await radio.activityStatus()
      expect(status).toBe('callInProgress')
    })

    it('parses asleep status (5)', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\n+CPAS: 5\r\n\r\nOK\r\n',
      })

      const status = await radio.activityStatus()
      expect(status).toBe('asleep')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\nOK\r\n',
      })

      await expect(radio.activityStatus()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(radio.activityStatus()).rejects.toThrow('Failed to parse')
    })

    it('throws ParseError on unknown status code', async () => {
      transport.autoRespond({
        'AT+CPAS\r': '\r\n+CPAS: 99\r\n\r\nOK\r\n',
      })

      await expect(radio.activityStatus()).rejects.toThrow('Unknown CPAS status')
    })
  })

  // ── Wireless Service Selection ───────────────────────────────────────

  describe('wirelessService()', () => {
    it('parses auto mode', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 25\r\n\r\nOK\r\n',
      })

      const service = await radio.wirelessService()
      expect(service).toBe('auto')
    })

    it('parses GSM only', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 12\r\n\r\nOK\r\n',
      })

      const service = await radio.wirelessService()
      expect(service).toBe('gsm')
    })

    it('parses LTE only', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 28\r\n\r\nOK\r\n',
      })

      const service = await radio.wirelessService()
      expect(service).toBe('lte')
    })

    it('parses UTRAN only', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 22\r\n\r\nOK\r\n',
      })

      const service = await radio.wirelessService()
      expect(service).toBe('utran')
    })

    it('parses auto with 5G', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 35\r\n\r\nOK\r\n',
      })

      const service = await radio.wirelessService()
      expect(service).toBe('autoWith5g')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\nOK\r\n',
      })

      await expect(radio.wirelessService()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\nBADDATA\r\n\r\nOK\r\n',
      })

      await expect(radio.wirelessService()).rejects.toThrow('Failed to parse')
    })

    it('throws ParseError on unknown WS46 code', async () => {
      transport.autoRespond({
        'AT+WS46?\r': '\r\n+WS46: 99\r\n\r\nOK\r\n',
      })

      await expect(radio.wirelessService()).rejects.toThrow('Unknown WS46 code')
    })
  })

  describe('setWirelessService()', () => {
    it('sets auto mode', async () => {
      transport.autoRespond({
        'AT+WS46=25\r': '\r\nOK\r\n',
      })

      await radio.setWirelessService('auto')
    })

    it('sets LTE only', async () => {
      transport.autoRespond({
        'AT+WS46=28\r': '\r\nOK\r\n',
      })

      await radio.setWirelessService('lte')
    })

    it('sets GSM only', async () => {
      transport.autoRespond({
        'AT+WS46=12\r': '\r\nOK\r\n',
      })

      await radio.setWirelessService('gsm')
    })

    it('sets NR only', async () => {
      transport.autoRespond({
        'AT+WS46=36\r': '\r\nOK\r\n',
      })

      await radio.setWirelessService('nrOnly')
    })
  })
})
