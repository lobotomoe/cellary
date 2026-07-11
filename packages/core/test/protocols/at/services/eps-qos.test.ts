import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DataModule } from '../../../../src/protocols/at/services/data.js'
import { MockTransport } from '../../../../src/transport/mock.js'

function createModule(): { transport: MockTransport; channel: ATChannel; data: DataModule } {
  const transport = new MockTransport()
  const channel = new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
  const data = new DataModule(channel, genericProfile.at)
  return { transport, channel, data }
}

describe('DataModule -- EPS QoS', () => {
  let transport: MockTransport
  let channel: ATChannel
  let data: DataModule

  beforeEach(async () => {
    ;({ transport, channel, data } = createModule())
    await transport.open()
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── epsQos() ──────────────────────────────────────────────────────────

  describe('epsQos()', () => {
    it('parses QoS with all fields', async () => {
      transport.autoRespond({
        'AT+CGEQOS?\r': '\r\n+CGEQOS: 1,9,1000,500,2000,1000\r\n\r\nOK\r\n',
      })

      const params = await data.epsQos()
      expect(params).toHaveLength(1)
      expect(params[0]?.cid).toBe(1)
      expect(params[0]?.qci).toBe(9)
      expect(params[0]?.dlGbr).toBe(1000)
      expect(params[0]?.ulGbr).toBe(500)
      expect(params[0]?.dlMbr).toBe(2000)
      expect(params[0]?.ulMbr).toBe(1000)
    })

    it('parses QoS with only QCI (no GBR/MBR)', async () => {
      transport.autoRespond({
        'AT+CGEQOS?\r': '\r\n+CGEQOS: 1,6\r\n\r\nOK\r\n',
      })

      const params = await data.epsQos()
      expect(params).toHaveLength(1)
      expect(params[0]?.cid).toBe(1)
      expect(params[0]?.qci).toBe(6)
      expect(params[0]?.dlGbr).toBeUndefined()
      expect(params[0]?.ulGbr).toBeUndefined()
      expect(params[0]?.dlMbr).toBeUndefined()
      expect(params[0]?.ulMbr).toBeUndefined()
    })

    it('parses QoS with GBR but no MBR', async () => {
      transport.autoRespond({
        'AT+CGEQOS?\r': '\r\n+CGEQOS: 1,1,512,256\r\n\r\nOK\r\n',
      })

      const params = await data.epsQos()
      expect(params).toHaveLength(1)
      expect(params[0]?.dlGbr).toBe(512)
      expect(params[0]?.ulGbr).toBe(256)
      expect(params[0]?.dlMbr).toBeUndefined()
      expect(params[0]?.ulMbr).toBeUndefined()
    })

    it('parses multiple contexts', async () => {
      transport.autoRespond({
        'AT+CGEQOS?\r': '\r\n+CGEQOS: 1,9\r\n' + '+CGEQOS: 2,6,1000,500\r\n' + '\r\nOK\r\n',
      })

      const params = await data.epsQos()
      expect(params).toHaveLength(2)
      expect(params[0]?.cid).toBe(1)
      expect(params[1]?.cid).toBe(2)
    })

    it('returns empty array when no QoS configured', async () => {
      transport.autoRespond({
        'AT+CGEQOS?\r': '\r\nOK\r\n',
      })

      const params = await data.epsQos()
      expect(params).toHaveLength(0)
    })

    it('queries specific cid', async () => {
      transport.autoRespond({
        'AT+CGEQOS=1\r': '\r\n+CGEQOS: 1,9\r\n\r\nOK\r\n',
      })

      const params = await data.epsQos(1)
      expect(params).toHaveLength(1)
      expect(params[0]?.cid).toBe(1)
    })
  })

  // ── negotiatedEpsQos() ────────────────────────────────────────────────

  describe('negotiatedEpsQos()', () => {
    it('parses negotiated QoS', async () => {
      transport.autoRespond({
        'AT+CGEQOSRDP\r': '\r\n+CGEQOS: 1,9,1000,500,2000,1000\r\n\r\nOK\r\n',
      })

      const params = await data.negotiatedEpsQos()
      expect(params).toHaveLength(1)
      expect(params[0]?.qci).toBe(9)
    })

    it('queries specific cid', async () => {
      transport.autoRespond({
        'AT+CGEQOSRDP=2\r': '\r\n+CGEQOS: 2,6\r\n\r\nOK\r\n',
      })

      const params = await data.negotiatedEpsQos(2)
      expect(params).toHaveLength(1)
      expect(params[0]?.cid).toBe(2)
    })
  })

  // ── setEpsQos() ──────────────────────────────────────────────────────

  describe('setEpsQos()', () => {
    it('sends QCI only', async () => {
      transport.autoRespond({
        'AT+CGEQOS=1,9\r': '\r\nOK\r\n',
      })

      await data.setEpsQos({ cid: 1, qci: 9 })
    })

    it('sends QCI with GBR', async () => {
      transport.autoRespond({
        'AT+CGEQOS=1,1,512,256\r': '\r\nOK\r\n',
      })

      await data.setEpsQos({ cid: 1, qci: 1, dlGbr: 512, ulGbr: 256 })
    })

    it('sends QCI with GBR and MBR', async () => {
      transport.autoRespond({
        'AT+CGEQOS=1,1,512,256,2000,1000\r': '\r\nOK\r\n',
      })

      await data.setEpsQos({ cid: 1, qci: 1, dlGbr: 512, ulGbr: 256, dlMbr: 2000, ulMbr: 1000 })
    })
  })
})

describe('DataModule -- UE mode', () => {
  let transport: MockTransport
  let channel: ATChannel
  let data: DataModule

  beforeEach(async () => {
    ;({ transport, channel, data } = createModule())
    await transport.open()
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── ueMode() ──────────────────────────────────────────────────────────

  describe('ueMode()', () => {
    it('parses psMode2 (mode=0)', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\n+CEMODE: 0\r\n\r\nOK\r\n',
      })

      const mode = await data.ueMode()
      expect(mode).toBe('psMode2')
    })

    it('parses csPsMode1 (mode=1)', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\n+CEMODE: 1\r\n\r\nOK\r\n',
      })

      const mode = await data.ueMode()
      expect(mode).toBe('csPsMode1')
    })

    it('parses csPsMode2 (mode=2)', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\n+CEMODE: 2\r\n\r\nOK\r\n',
      })

      const mode = await data.ueMode()
      expect(mode).toBe('csPsMode2')
    })

    it('parses psMode1 (mode=3)', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\n+CEMODE: 3\r\n\r\nOK\r\n',
      })

      const mode = await data.ueMode()
      expect(mode).toBe('psMode1')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\nOK\r\n',
      })

      await expect(data.ueMode()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on unknown mode', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\n+CEMODE: 9\r\n\r\nOK\r\n',
      })

      await expect(data.ueMode()).rejects.toThrow('Unknown UE mode code')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CEMODE?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(data.ueMode()).rejects.toThrow('Failed to parse')
    })
  })

  // ── setUeMode() ──────────────────────────────────────────────────────

  describe('setUeMode()', () => {
    it('sends psMode2 as code 0', async () => {
      transport.autoRespond({
        'AT+CEMODE=0\r': '\r\nOK\r\n',
      })

      await data.setUeMode('psMode2')
    })

    it('sends csPsMode1 as code 1', async () => {
      transport.autoRespond({
        'AT+CEMODE=1\r': '\r\nOK\r\n',
      })

      await data.setUeMode('csPsMode1')
    })

    it('sends csPsMode2 as code 2', async () => {
      transport.autoRespond({
        'AT+CEMODE=2\r': '\r\nOK\r\n',
      })

      await data.setUeMode('csPsMode2')
    })

    it('sends psMode1 as code 3', async () => {
      transport.autoRespond({
        'AT+CEMODE=3\r': '\r\nOK\r\n',
      })

      await data.setUeMode('psMode1')
    })
  })
})
