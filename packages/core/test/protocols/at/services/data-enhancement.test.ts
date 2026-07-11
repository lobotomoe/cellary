import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DataModule } from '../../../../src/protocols/at/services/data.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

describe('DataModule -- enhanced commands', () => {
  let transport: MockTransport
  let channel: ATChannel
  let data: DataModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    data = new DataModule(channel, atConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── AT+CGCONTRDP (Section 10.1.23) ────────────────────────────────────

  describe('dynamicParameters()', () => {
    it('parses full response with DNS and gateway', async () => {
      transport.autoRespond({
        'AT+CGCONTRDP=1\r':
          '\r\n+CGCONTRDP: 1,5,"internet","10.0.0.1.255.255.255.0","10.0.0.254","8.8.8.8","8.8.4.4"\r\n\r\nOK\r\n',
      })

      const params = await data.dynamicParameters(1)
      expect(params).toHaveLength(1)
      const [p] = params
      if (p === undefined) throw new Error('expected one context')
      expect(p.cid).toBe(1)
      expect(p.bearerId).toBe(5)
      expect(p.apn).toBe('internet')
      expect(p.localAddress).toBe('10.0.0.1.255.255.255.0')
      expect(p.gatewayAddress).toBe('10.0.0.254')
      expect(p.primaryDns).toBe('8.8.8.8')
      expect(p.secondaryDns).toBe('8.8.4.4')
    })

    it('parses response with only IP address', async () => {
      transport.autoRespond({
        'AT+CGCONTRDP=1\r': '\r\n+CGCONTRDP: 1,5,"myapn","192.168.1.100"\r\n\r\nOK\r\n',
      })

      const params = await data.dynamicParameters(1)
      expect(params).toHaveLength(1)
      const [p] = params
      if (p === undefined) throw new Error('expected one context')
      expect(p.cid).toBe(1)
      expect(p.localAddress).toBe('192.168.1.100')
      expect(p.gatewayAddress).toBeUndefined()
      expect(p.primaryDns).toBeUndefined()
    })

    it('parses multiple contexts when no cid specified', async () => {
      transport.autoRespond({
        'AT+CGCONTRDP\r':
          '\r\n+CGCONTRDP: 1,5,"internet","10.0.0.1","","8.8.8.8"\r\n' +
          '+CGCONTRDP: 2,6,"mms","10.0.0.2"\r\n\r\nOK\r\n',
      })

      const params = await data.dynamicParameters()
      expect(params).toHaveLength(2)
      const [first, second] = params
      if (first === undefined || second === undefined) throw new Error('expected two contexts')
      expect(first.cid).toBe(1)
      expect(first.apn).toBe('internet')
      expect(second.cid).toBe(2)
      expect(second.apn).toBe('mms')
    })

    it('returns empty array on empty response', async () => {
      transport.autoRespond({
        'AT+CGCONTRDP=1\r': '\r\nOK\r\n',
      })

      const params = await data.dynamicParameters(1)
      expect(params).toHaveLength(0)
    })

    it('handles empty string fields as undefined', async () => {
      transport.autoRespond({
        'AT+CGCONTRDP=1\r': '\r\n+CGCONTRDP: 1,5,"","","",""\r\n\r\nOK\r\n',
      })

      const params = await data.dynamicParameters(1)
      expect(params).toHaveLength(1)
      const [p] = params
      if (p === undefined) throw new Error('expected one context')
      expect(p.apn).toBeUndefined()
      expect(p.localAddress).toBeUndefined()
      expect(p.gatewayAddress).toBeUndefined()
    })
  })

  // ── AT+CGAUTH (Section 10.1.31) ──────────────────────────────────────

  describe('setAuthentication()', () => {
    it('sets PAP authentication with credentials', async () => {
      transport.autoRespond({
        'AT+CGAUTH=1,1,"user","pass"\r': '\r\nOK\r\n',
      })

      await data.setAuthentication(1, 'pap', 'user', 'pass')
    })

    it('sets CHAP authentication', async () => {
      transport.autoRespond({
        'AT+CGAUTH=2,2,"admin","secret"\r': '\r\nOK\r\n',
      })

      await data.setAuthentication(2, 'chap', 'admin', 'secret')
    })

    it('disables authentication', async () => {
      transport.autoRespond({
        'AT+CGAUTH=1,0\r': '\r\nOK\r\n',
      })

      await data.setAuthentication(1, 'none')
    })

    it('sets username without password', async () => {
      transport.autoRespond({
        'AT+CGAUTH=1,1,"user"\r': '\r\nOK\r\n',
      })

      await data.setAuthentication(1, 'pap', 'user')
    })
  })

  // ── AT+CGCMOD (Section 10.1.11) ──────────────────────────────────────

  describe('modify()', () => {
    it('sends modify command for a context', async () => {
      transport.autoRespond({
        'AT+CGCMOD=1\r': '\r\nOK\r\n',
      })

      await data.modify(1)
    })

    it('sends modify command for different cid', async () => {
      transport.autoRespond({
        'AT+CGCMOD=3\r': '\r\nOK\r\n',
      })

      await data.modify(3)
    })
  })
})
