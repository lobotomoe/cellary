import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { VoiceModule } from '../../../../src/protocols/at/services/voice.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

describe('VoiceModule -- call supplementary services', () => {
  let transport: MockTransport
  let channel: ATChannel
  let voice: VoiceModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    voice = new VoiceModule(channel, atConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── CLIR ─────────────────────────────────────────────────────────────

  describe('queryClir()', () => {
    it('parses subscription default + not provisioned', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\n+CLIR: 0,0\r\n\r\nOK\r\n',
      })

      const result = await voice.queryClir()
      expect(result.setting).toBe('subscription')
      expect(result.status).toBe('notProvisioned')
    })

    it('parses invocation + permanent', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\n+CLIR: 1,1\r\n\r\nOK\r\n',
      })

      const result = await voice.queryClir()
      expect(result.setting).toBe('invocation')
      expect(result.status).toBe('permanent')
    })

    it('parses suppression + temporary allowed', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\n+CLIR: 2,4\r\n\r\nOK\r\n',
      })

      const result = await voice.queryClir()
      expect(result.setting).toBe('suppression')
      expect(result.status).toBe('temporaryAllowed')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\nOK\r\n',
      })

      await expect(voice.queryClir()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(voice.queryClir()).rejects.toThrow('Failed to parse')
    })

    it('throws ParseError on unknown CLIR values', async () => {
      transport.autoRespond({
        'AT+CLIR?\r': '\r\n+CLIR: 9,9\r\n\r\nOK\r\n',
      })

      await expect(voice.queryClir()).rejects.toThrow('Unknown CLIR values')
    })
  })

  describe('setClir()', () => {
    it('sets subscription default (n=0)', async () => {
      transport.autoRespond({
        'AT+CLIR=0\r': '\r\nOK\r\n',
      })

      await voice.setClir('subscription')
    })

    it('sets invocation / hide number (n=1)', async () => {
      transport.autoRespond({
        'AT+CLIR=1\r': '\r\nOK\r\n',
      })

      await voice.setClir('invocation')
    })

    it('sets suppression / show number (n=2)', async () => {
      transport.autoRespond({
        'AT+CLIR=2\r': '\r\nOK\r\n',
      })

      await voice.setClir('suppression')
    })
  })

  // ── Call Forwarding ──────────────────────────────────────────────────

  describe('queryCallForwarding()', () => {
    it('parses active rule with number', async () => {
      transport.autoRespond({
        'AT+CCFC=0,2\r': '\r\n+CCFC: 1,1,"+37499123456",145\r\n\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('unconditional')
      expect(rules).toHaveLength(1)
      expect(rules[0]?.active).toBe(true)
      expect(rules[0]?.serviceClass).toBe(1)
      expect(rules[0]?.number).toBe('+37499123456')
      expect(rules[0]?.numberFormat).toBe('international')
    })

    it('parses inactive rule without number', async () => {
      transport.autoRespond({
        'AT+CCFC=1,2\r': '\r\n+CCFC: 0,1\r\n\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('busy')
      expect(rules).toHaveLength(1)
      expect(rules[0]?.active).toBe(false)
      expect(rules[0]?.number).toBeUndefined()
    })

    it('parses multiple service classes', async () => {
      transport.autoRespond({
        'AT+CCFC=0,2\r':
          '\r\n+CCFC: 1,1,"+37499123456",145\r\n' +
          '+CCFC: 0,2\r\n' +
          '+CCFC: 0,4\r\n' +
          '\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('unconditional')
      expect(rules).toHaveLength(3)
      expect(rules[0]?.active).toBe(true)
      expect(rules[0]?.serviceClass).toBe(1)
      expect(rules[1]?.active).toBe(false)
      expect(rules[1]?.serviceClass).toBe(2)
      expect(rules[2]?.active).toBe(false)
      expect(rules[2]?.serviceClass).toBe(4)
    })

    it('parses no-reply rule with time parameter', async () => {
      transport.autoRespond({
        'AT+CCFC=2,2\r': '\r\n+CCFC: 1,1,"+37499123456",145,"",128,20\r\n\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('noReply')
      expect(rules).toHaveLength(1)
      expect(rules[0]?.time).toBe(20)
    })

    it('returns empty array when no rules', async () => {
      transport.autoRespond({
        'AT+CCFC=3,2\r': '\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('notReachable')
      expect(rules).toHaveLength(0)
    })

    it('passes service class filter', async () => {
      transport.autoRespond({
        'AT+CCFC=0,2,,,1\r': '\r\n+CCFC: 1,1,"+37499123456",145\r\n\r\nOK\r\n',
      })

      const rules = await voice.queryCallForwarding('unconditional', 1)
      expect(rules).toHaveLength(1)
    })
  })

  describe('setCallForwarding()', () => {
    it('disables unconditional forwarding', async () => {
      transport.autoRespond({
        'AT+CCFC=0,0\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('unconditional', 'disable')
    })

    it('registers forwarding with number (auto-detects international format)', async () => {
      transport.autoRespond({
        'AT+CCFC=0,3,"+37499123456",145\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('unconditional', 'register', {
        number: '+37499123456',
      })
    })

    it('enables forwarding for specific class', async () => {
      transport.autoRespond({
        'AT+CCFC=1,1,,,1\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('busy', 'enable', { serviceClass: 1 })
    })

    it('erases forwarding rule', async () => {
      transport.autoRespond({
        'AT+CCFC=0,4\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('unconditional', 'erase')
    })

    it('places the no-reply timer in the <time> slot, not <satype>', async () => {
      // TS 27.007 7.11 positional order: ...,<number>,<type>,<class>,<subaddr>,<satype>,<time>
      // With no class, <class>/<subaddr>/<satype> are empty and <time> is last.
      transport.autoRespond({
        'AT+CCFC=2,3,"+37491112233",145,,,,20\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('noReply', 'register', {
        number: '+37491112233',
        time: 20,
      })
    })

    it('places <time> after <class> when a service class is given', async () => {
      transport.autoRespond({
        'AT+CCFC=2,3,"+37491112233",145,1,,,20\r': '\r\nOK\r\n',
      })

      await voice.setCallForwarding('noReply', 'register', {
        number: '+37491112233',
        serviceClass: 1,
        time: 20,
      })
    })
  })

  // ── Call Waiting ─────────────────────────────────────────────────────

  describe('queryCallWaiting()', () => {
    it('parses active for voice class', async () => {
      transport.autoRespond({
        'AT+CCWA=1,2\r': '\r\n+CCWA: 1,1\r\n\r\nOK\r\n',
      })

      const entries = await voice.queryCallWaiting()
      expect(entries).toHaveLength(1)
      expect(entries[0]?.active).toBe(true)
      expect(entries[0]?.serviceClass).toBe(1)
    })

    it('parses inactive status', async () => {
      transport.autoRespond({
        'AT+CCWA=1,2\r': '\r\n+CCWA: 0,1\r\n\r\nOK\r\n',
      })

      const entries = await voice.queryCallWaiting()
      expect(entries[0]?.active).toBe(false)
    })

    it('parses multiple service classes', async () => {
      transport.autoRespond({
        'AT+CCWA=1,2\r': '\r\n+CCWA: 1,1\r\n' + '+CCWA: 0,2\r\n' + '+CCWA: 0,4\r\n' + '\r\nOK\r\n',
      })

      const entries = await voice.queryCallWaiting()
      expect(entries).toHaveLength(3)
      expect(entries[0]?.serviceClass).toBe(1)
      expect(entries[1]?.serviceClass).toBe(2)
      expect(entries[2]?.serviceClass).toBe(4)
    })

    it('passes service class filter', async () => {
      transport.autoRespond({
        'AT+CCWA=1,2,1\r': '\r\n+CCWA: 1,1\r\n\r\nOK\r\n',
      })

      const entries = await voice.queryCallWaiting(1)
      expect(entries).toHaveLength(1)
    })

    it('returns empty array when no response lines', async () => {
      transport.autoRespond({
        'AT+CCWA=1,2\r': '\r\nOK\r\n',
      })

      const entries = await voice.queryCallWaiting()
      expect(entries).toHaveLength(0)
    })
  })

  describe('setCallWaiting()', () => {
    it('enables call waiting', async () => {
      transport.autoRespond({
        'AT+CCWA=1,1\r': '\r\nOK\r\n',
      })

      await voice.setCallWaiting(true)
    })

    it('disables call waiting', async () => {
      transport.autoRespond({
        'AT+CCWA=1,0\r': '\r\nOK\r\n',
      })

      await voice.setCallWaiting(false)
    })

    it('enables for specific service class', async () => {
      transport.autoRespond({
        'AT+CCWA=1,1,1\r': '\r\nOK\r\n',
      })

      await voice.setCallWaiting(true, 1)
    })
  })

  // ── Call Hold ─────────────────────────────────────────────────────────

  describe('holdAndAccept()', () => {
    it('sends AT+CHLD=2', async () => {
      transport.autoRespond({
        'AT+CHLD=2\r': '\r\nOK\r\n',
      })

      await voice.holdAndAccept()
    })
  })

  describe('conference()', () => {
    it('sends AT+CHLD=3', async () => {
      transport.autoRespond({
        'AT+CHLD=3\r': '\r\nOK\r\n',
      })

      await voice.conference()
    })
  })

  describe('releaseHeld()', () => {
    it('sends AT+CHLD=0', async () => {
      transport.autoRespond({
        'AT+CHLD=0\r': '\r\nOK\r\n',
      })

      await voice.releaseHeld()
    })
  })
})
