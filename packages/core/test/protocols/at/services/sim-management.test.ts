import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DeviceModule } from '../../../../src/protocols/at/services/device.js'
import { SimModule } from '../../../../src/protocols/at/services/sim.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

describe('SimModule -- SIM management commands', () => {
  let transport: MockTransport
  let channel: ATChannel
  let sim: SimModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    sim = new SimModule(channel, atConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── AT+CPINR (Section 8.65) ─────────────────────────────────────────────

  describe('pinRetries()', () => {
    it('parses all 4 retry counts', async () => {
      transport.autoRespond({
        'AT+CPINR\r':
          '\r\n+CPINR: "SIM PIN",3\r\n' +
          '+CPINR: "SIM PUK",10\r\n' +
          '+CPINR: "SIM PIN2",3\r\n' +
          '+CPINR: "SIM PUK2",10\r\n' +
          '\r\nOK\r\n',
      })

      const retries = await sim.pinRetries()
      expect(retries.pin).toBe(3)
      expect(retries.puk).toBe(10)
      expect(retries.pin2).toBe(3)
      expect(retries.puk2).toBe(10)
    })

    it('parses PIN and PUK only (no PIN2/PUK2)', async () => {
      transport.autoRespond({
        'AT+CPINR\r': '\r\n+CPINR: "SIM PIN",2\r\n' + '+CPINR: "SIM PUK",8\r\n' + '\r\nOK\r\n',
      })

      const retries = await sim.pinRetries()
      expect(retries.pin).toBe(2)
      expect(retries.puk).toBe(8)
      expect(retries.pin2).toBeUndefined()
      expect(retries.puk2).toBeUndefined()
    })

    it('handles zero retries remaining (PIN blocked)', async () => {
      transport.autoRespond({
        'AT+CPINR\r': '\r\n+CPINR: "SIM PIN",0\r\n' + '+CPINR: "SIM PUK",10\r\n' + '\r\nOK\r\n',
      })

      const retries = await sim.pinRetries()
      expect(retries.pin).toBe(0)
      expect(retries.puk).toBe(10)
    })

    it('handles unquoted code names', async () => {
      // Some modems return codes without quotes
      transport.autoRespond({
        'AT+CPINR\r': '\r\n+CPINR: SIM PIN,3\r\n' + '+CPINR: SIM PUK,10\r\n' + '\r\nOK\r\n',
      })

      const retries = await sim.pinRetries()
      expect(retries.pin).toBe(3)
      expect(retries.puk).toBe(10)
    })

    it('throws ParseError when PIN/PUK lines are missing', async () => {
      transport.autoRespond({
        'AT+CPINR\r': '\r\nOK\r\n',
      })

      await expect(sim.pinRetries()).rejects.toThrow('missing PIN/PUK retry counts')
    })
  })

  // ── AT+CLCK (Section 7.4) ──────────────────────────────────────────────

  describe('queryFacilityLock()', () => {
    it('returns true when facility is active', async () => {
      transport.autoRespond({
        'AT+CLCK="SC",2\r': '\r\n+CLCK: 1\r\n\r\nOK\r\n',
      })

      const locked = await sim.queryFacilityLock('SC')
      expect(locked).toBe(true)
    })

    it('returns false when facility is not active', async () => {
      transport.autoRespond({
        'AT+CLCK="SC",2\r': '\r\n+CLCK: 0\r\n\r\nOK\r\n',
      })

      const locked = await sim.queryFacilityLock('SC')
      expect(locked).toBe(false)
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CLCK="FD",2\r': '\r\nOK\r\n',
      })

      await expect(sim.queryFacilityLock('FD')).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CLCK="SC",2\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(sim.queryFacilityLock('SC')).rejects.toThrow('Failed to parse')
    })
  })

  describe('setFacilityLock()', () => {
    it('enables SIM PIN lock with password', async () => {
      transport.autoRespond({
        'AT+CLCK="SC",1,"1234"\r': '\r\nOK\r\n',
      })

      await sim.setFacilityLock('SC', true, '1234')
    })

    it('disables SIM PIN lock with password', async () => {
      transport.autoRespond({
        'AT+CLCK="SC",0,"1234"\r': '\r\nOK\r\n',
      })

      await sim.setFacilityLock('SC', false, '1234')
    })

    it('sends without password when not provided', async () => {
      transport.autoRespond({
        'AT+CLCK="PN",0\r': '\r\nOK\r\n',
      })

      await sim.setFacilityLock('PN', false)
    })

    it('includes service class when provided', async () => {
      transport.autoRespond({
        'AT+CLCK="AO",1,"0000",1\r': '\r\nOK\r\n',
      })

      await sim.setFacilityLock('AO', true, '0000', 1)
    })
  })

  // ── AT+CPWD (Section 7.5) ──────────────────────────────────────────────

  describe('changePassword()', () => {
    it('changes SIM PIN', async () => {
      transport.autoRespond({
        'AT+CPWD="SC","1234","5678"\r': '\r\nOK\r\n',
      })

      await sim.changePassword('SC', '1234', '5678')
    })

    it('changes SIM PIN2', async () => {
      transport.autoRespond({
        'AT+CPWD="P2","0000","9999"\r': '\r\nOK\r\n',
      })

      await sim.changePassword('P2', '0000', '9999')
    })

    it('changes barring password', async () => {
      transport.autoRespond({
        'AT+CPWD="AB","1234","4321"\r': '\r\nOK\r\n',
      })

      await sim.changePassword('AB', '1234', '4321')
    })
  })
})

// ── AT+CSCS (Section 5.5) ──────────────────────────────────────────────

describe('DeviceModule -- character set commands', () => {
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

  describe('characterSet()', () => {
    it('parses quoted charset response', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\n+CSCS: "IRA"\r\n\r\nOK\r\n',
      })

      const charset = await device.characterSet()
      expect(charset).toBe('IRA')
    })

    it('parses GSM charset', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\n+CSCS: "GSM"\r\n\r\nOK\r\n',
      })

      const charset = await device.characterSet()
      expect(charset).toBe('GSM')
    })

    it('parses UCS2 charset', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\n+CSCS: "UCS2"\r\n\r\nOK\r\n',
      })

      const charset = await device.characterSet()
      expect(charset).toBe('UCS2')
    })

    it('parses UTF-8 charset', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\n+CSCS: "UTF-8"\r\n\r\nOK\r\n',
      })

      const charset = await device.characterSet()
      expect(charset).toBe('UTF-8')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\nOK\r\n',
      })

      await expect(device.characterSet()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CSCS?\r': '\r\nBADDATA\r\n\r\nOK\r\n',
      })

      await expect(device.characterSet()).rejects.toThrow('Failed to parse')
    })
  })

  describe('setCharacterSet()', () => {
    it('sets charset to UCS2', async () => {
      transport.autoRespond({
        'AT+CSCS="UCS2"\r': '\r\nOK\r\n',
      })

      await device.setCharacterSet('UCS2')
    })

    it('sets charset to UTF-8', async () => {
      transport.autoRespond({
        'AT+CSCS="UTF-8"\r': '\r\nOK\r\n',
      })

      await device.setCharacterSet('UTF-8')
    })
  })
})
