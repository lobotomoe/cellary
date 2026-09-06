import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { SimModule } from '../../../../src/protocols/at/services/sim.js'
import { normalizeIccid } from '../../../../src/protocols/iccid.js'
import { MockTransport } from '../../../../src/transport/mock.js'
import { huaweiProfile } from '../../../../src/vendor/huawei/profile.js'
import { zteProfile } from '../../../../src/vendor/zte/profile.js'

const genericAtConfig = requireAtConfig(genericProfile)
const huaweiAtConfig = requireAtConfig(huaweiProfile)
const zteAtConfig = requireAtConfig(zteProfile)

describe('SimModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let sim: SimModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: genericAtConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    sim = new SimModule(channel, genericAtConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('iccid()', () => {
    it('parses +CCID: prefixed response', async () => {
      transport.autoRespond({ 'AT+CCID\r': '\r\n+CCID: 89014103211118510720\r\n\r\nOK\r\n' })

      const iccid = await sim.iccid()
      expect(iccid).toBe('89014103211118510720')
    })

    it('parses raw ICCID response (no prefix)', async () => {
      transport.autoRespond({ 'AT+CCID\r': '\r\n89014103211118510720\r\n\r\nOK\r\n' })

      const iccid = await sim.iccid()
      expect(iccid).toBe('89014103211118510720')
    })

    it('throws ParseError when response has no data', async () => {
      transport.autoRespond({ 'AT+CCID\r': '\r\nOK\r\n' })

      await expect(sim.iccid()).rejects.toThrow('AT+CCID returned no data')
    })

    it('uses Huawei vendor command AT^ICCID? when profile specifies it', async () => {
      const huaweiSim = new SimModule(channel, huaweiAtConfig)
      transport.autoRespond({
        'AT^ICCID?\r': '\r\n^ICCID: 890000000000000000FF\r\n\r\nOK\r\n',
      })

      const iccid = await huaweiSim.iccid()
      // Trailing FF stripped per ITU-T E.118 BCD padding
      expect(iccid).toBe('890000000000000000')
    })

    it('handles ^ICCID: prefix in response', async () => {
      transport.autoRespond({
        'AT+CCID\r': '\r\n^ICCID: 89014103211118510720\r\n\r\nOK\r\n',
      })

      const iccid = await sim.iccid()
      expect(iccid).toBe('89014103211118510720')
    })

    it('uses ZTE vendor command AT+ICCID and strips the "ICCID:" prefix', async () => {
      const zteSim = new SimModule(channel, zteAtConfig)
      transport.autoRespond({
        'AT+ICCID\r': '\r\nICCID: 897011102041377508\r\n\r\nOK\r\n',
      })

      const iccid = await zteSim.iccid()
      expect(iccid).toBe('897011102041377508')
    })
  })

  describe('info()', () => {
    it('returns complete info when SIM is ready', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\n+CPIN: READY\r\n\r\nOK\r\n',
        'AT+CCID\r': '\r\n+CCID: 89014103211118510720\r\n\r\nOK\r\n',
        'AT+CIMI\r': '\r\n310260000000001\r\n\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0,0,"T-Mobile"\r\n\r\nOK\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('ready')
      expect(info.iccid).toBe('89014103211118510720')
      expect(info.imsi).toBe('310260000000001')
      expect(info.operator).toBe('T-Mobile')
    })

    it('handles PIN required state', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\n+CPIN: SIM PIN\r\n\r\nOK\r\n',
        'AT+CCID\r': '\r\n+CCID: 89014103211118510720\r\n\r\nOK\r\n',
        'AT+CIMI\r': '\r\n+CME ERROR: 11\r\n', // SIM PIN required
        'AT+COPS?\r': '\r\n+CME ERROR: 11\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('pinRequired')
      expect(info.iccid).toBe('89014103211118510720')
      expect(info.imsi).toBeUndefined()
      expect(info.operator).toBeUndefined()
    })

    it('handles SIM absent (CME ERROR 10)', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\n+CME ERROR: 10\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('absent')
      expect(info.iccid).toBeUndefined()
    })

    it('handles PUK required state', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\n+CPIN: SIM PUK\r\n\r\nOK\r\n',
        'AT+CCID\r': '\r\n+CCID: 89014103211118510720\r\n\r\nOK\r\n',
        'AT+CIMI\r': '\r\n+CME ERROR: 12\r\n',
        'AT+COPS?\r': '\r\n+CME ERROR: 12\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('pukRequired')
    })

    it('handles network-locked state (PH-NET PIN)', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\n+CPIN: PH-NET PIN\r\n\r\nOK\r\n',
        'AT+CCID\r': '\r\n+CCID: 89014103211118510720\r\n\r\nOK\r\n',
        'AT+CIMI\r': '\r\n+CME ERROR: 11\r\n',
        'AT+COPS?\r': '\r\n+CME ERROR: 11\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('networkLocked')
    })

    it('handles generic error response', async () => {
      transport.autoRespond({
        'AT+CPIN?\r': '\r\nERROR\r\n',
      })

      const info = await sim.info()
      expect(info.state).toBe('error')
    })

    it('skips AT+CPIN? when markAbsent() was called', async () => {
      // No autoRespond for AT+CPIN? — if it's sent, the test will hang/fail
      sim.markAbsent()

      const info = await sim.info()
      expect(info.state).toBe('absent')
      expect(info.iccid).toBeUndefined()
    })
  })
})

// ── normalizeIccid() unit tests ────────────────────────────────────────────

describe('normalizeIccid()', () => {
  it('returns a clean ICCID unchanged', () => {
    expect(normalizeIccid('89014103211118510720')).toBe('89014103211118510720')
  })

  it('strips trailing F padding (uppercase)', () => {
    expect(normalizeIccid('890000000000000000FF')).toBe('890000000000000000')
  })

  it('strips trailing f padding (lowercase)', () => {
    expect(normalizeIccid('890000000000000000ff')).toBe('890000000000000000')
  })

  it('strips single trailing F', () => {
    expect(normalizeIccid('8901410321111851072F')).toBe('8901410321111851072')
  })

  it('preserves ICCIDs starting with 98 (not nibble-swapped)', () => {
    expect(normalizeIccid('9810')).toBe('9810')
  })

  it('throws on all-F input (no valid digits)', () => {
    expect(() => normalizeIccid('FFFFFFFFFF')).toThrow('ICCID contains only padding bytes')
  })

  it('strips non-standard trailing padding (Alcatel JRD pads with "p")', () => {
    expect(normalizeIccid('897011102041377508pp')).toBe('897011102041377508')
  })

  it('throws on empty input', () => {
    expect(() => normalizeIccid('')).toThrow('ICCID contains only padding bytes')
  })
})
