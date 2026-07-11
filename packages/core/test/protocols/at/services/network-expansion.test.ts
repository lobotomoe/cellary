import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { NetworkModule } from '../../../../src/protocols/at/services/network.js'
import type {
  AtConfig,
  EnhancedSignalData,
  SignalQueryConfig,
} from '../../../../src/protocols/at/types.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const genericAtConfig = requireAtConfig(genericProfile)

function createChannel(transport: MockTransport, atConfig: AtConfig = genericAtConfig): ATChannel {
  return new ATChannel(transport, {
    urcPrefixes: atConfig.urcPrefixes,
    defaultTimeout: 5000,
  })
}

describe('NetworkModule (expansion)', () => {
  let transport: MockTransport
  let channel: ATChannel
  let network: NetworkModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = createChannel(transport)
    network = new NetworkModule(channel, genericAtConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── AT+CESQ ─────────────────────────────────────────────────────────────

  describe('signal() with CESQ fallback', () => {
    it('returns CESQ LTE metrics when no vendor signal configured', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        // LTE: rxlev=99(unknown), ber=99(unknown), rscp=255(unknown), ecno=255(unknown),
        //      rsrq=15, rsrp=60
        'AT+CESQ\r': '\r\n+CESQ: 99,99,255,255,15,60\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      // Base from CSQ
      expect(info.rssi).toBe(-113 + 20 * 2) // -73 dBm
      expect(info.bitErrorRate).toBe(0)
      // From CESQ: technology inferred as LTE
      expect(info.technology).toBe('LTE')
      // rsrp = -140 + 60 = -80 dBm
      expect(info.rsrp).toBe(-80)
      // rsrq = -19.5 + 15 * 0.5 = -12 dB
      expect(info.rsrq).toBe(-12)
    })

    it('returns CESQ WCDMA metrics (rscp, ecno)', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 15,99\r\n\r\nOK\r\n',
        // WCDMA: rxlev=99(unknown), ber=99, rscp=50, ecno=30, rsrq=255(unknown), rsrp=255(unknown)
        'AT+CESQ\r': '\r\n+CESQ: 99,99,50,30,255,255\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.technology).toBe('3G')
      // rscp = -120 + 50 = -70 dBm
      expect(info.rscp).toBe(-70)
      // ecno = -24 + 30 * 0.5 = -9 dB
      expect(info.ecno).toBe(-9)
    })

    it('returns CESQ GSM metrics (refined rssi)', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,3\r\n\r\nOK\r\n',
        // GSM: rxlev=45, ber=3, rscp=255(unknown), ecno=255(unknown),
        //      rsrq=255(unknown), rsrp=255(unknown)
        'AT+CESQ\r': '\r\n+CESQ: 45,3,255,255,255,255\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.technology).toBe('GSM')
      // rssi from CESQ overrides CSQ: -110 + 45 = -65 dBm (finer granularity)
      expect(info.rssi).toBe(-65)
    })

    it('returns CSQ-only when CESQ has all unknowns', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        'AT+CESQ\r': '\r\n+CESQ: 99,99,255,255,255,255\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.rssi).toBe(-73)
      expect(info.bitErrorRate).toBe(0)
      expect(info.technology).toBeUndefined()
      expect(info.rsrp).toBeUndefined()
    })

    it('returns CSQ-only when CESQ is not supported', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 10,7\r\n\r\nOK\r\n',
        'AT+CESQ\r': '\r\nERROR\r\n',
      })

      const info = await network.signal()
      expect(info.rssi).toBe(-93)
      expect(info.bitErrorRate).toBe(7)
      expect(info.technology).toBeUndefined()
    })

    it('skips CESQ when vendor signal config succeeds', async () => {
      const vendorSignal: SignalQueryConfig = {
        command: 'AT^HCSQ?',
        parse: (): EnhancedSignalData => ({
          technology: 'LTE',
          rsrp: -85,
          rsrq: -10,
          sinr: 15,
        }),
      }
      const profileWithVendor: AtConfig = { ...genericAtConfig, signal: vendorSignal }
      channel.dispose()
      channel = createChannel(transport, profileWithVendor)
      network = new NetworkModule(channel, profileWithVendor)

      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        'AT^HCSQ?\r': '\r\n^HCSQ: "LTE",55,85,150,30\r\n\r\nOK\r\n',
        // CESQ should NOT be called when vendor signal succeeds
      })

      const info = await network.signal()
      expect(info.technology).toBe('LTE')
      expect(info.rsrp).toBe(-85)
      expect(info.sinr).toBe(15)
    })

    it('falls through to CESQ when vendor signal fails', async () => {
      const vendorSignal: SignalQueryConfig = {
        command: 'AT^HCSQ?',
        parse: (): EnhancedSignalData => {
          throw new Error('parse fail')
        },
      }
      const profileWithVendor: AtConfig = { ...genericAtConfig, signal: vendorSignal }
      channel.dispose()
      channel = createChannel(transport, profileWithVendor)
      network = new NetworkModule(channel, profileWithVendor)

      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        'AT^HCSQ?\r': '\r\nERROR\r\n',
        'AT+CESQ\r': '\r\n+CESQ: 99,99,255,255,10,50\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.technology).toBe('LTE')
      // rsrp = -140 + 50 = -90
      expect(info.rsrp).toBe(-90)
    })

    it('handles CESQ response with missing data gracefully', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        'AT+CESQ\r': '\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.rssi).toBe(-73)
      expect(info.technology).toBeUndefined()
    })

    it('CESQ LTE with rsrq unknown', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 20,0\r\n\r\nOK\r\n',
        // rsrp valid (60), rsrq unknown (255)
        'AT+CESQ\r': '\r\n+CESQ: 99,99,255,255,255,60\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.technology).toBe('LTE')
      expect(info.rsrp).toBe(-80)
      expect(info.rsrq).toBeUndefined()
    })

    it('CESQ WCDMA with ecno unknown', async () => {
      transport.autoRespond({
        'AT+CSQ\r': '\r\n+CSQ: 15,99\r\n\r\nOK\r\n',
        // rscp valid (50), ecno unknown (255)
        'AT+CESQ\r': '\r\n+CESQ: 99,99,50,255,255,255\r\n\r\nOK\r\n',
      })

      const info = await network.signal()
      expect(info.technology).toBe('3G')
      expect(info.rscp).toBe(-70)
      expect(info.ecno).toBeUndefined()
    })
  })

  // ── AT+CEREG ────────────────────────────────────────────────────────────

  describe('epsRegistration()', () => {
    it('parses full CEREG response with TAC, Cell ID, and AcT', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\n+CEREG: 1,1,"00C3","0000A13F",7\r\n\r\nOK\r\n',
      })

      const info = await network.epsRegistration()
      expect(info.status).toBe('home')
      expect(info.locationAreaCode).toBe('00C3')
      expect(info.cellId).toBe('0000A13F')
      expect(info.technology).toBe('LTE')
    })

    it('parses minimal CEREG response (status only)', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\n+CEREG: 0,2\r\n\r\nOK\r\n',
      })

      const info = await network.epsRegistration()
      expect(info.status).toBe('searching')
      expect(info.locationAreaCode).toBeUndefined()
      expect(info.cellId).toBeUndefined()
    })

    it('parses roaming status', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\n+CEREG: 2,5,"003D","00278120",7\r\n\r\nOK\r\n',
      })

      const info = await network.epsRegistration()
      expect(info.status).toBe('roaming')
      expect(info.locationAreaCode).toBe('003D')
      expect(info.cellId).toBe('00278120')
      expect(info.technology).toBe('LTE')
    })

    it('does NOT fall back to COPS for technology (unlike CREG)', async () => {
      // CEREG always has AcT when it has location info (EPS-only command)
      transport.autoRespond({
        'AT+CEREG?\r': '\r\n+CEREG: 0,1\r\n\r\nOK\r\n',
      })

      const info = await network.epsRegistration()
      expect(info.status).toBe('home')
      expect(info.technology).toBeUndefined()
    })

    it('ignores all-zeros cell ID', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\n+CEREG: 1,1,"00C3","00000000",7\r\n\r\nOK\r\n',
      })

      const info = await network.epsRegistration()
      expect(info.cellId).toBeUndefined()
      expect(info.locationAreaCode).toBe('00C3')
    })

    it('throws ParseError when response has no data', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\nOK\r\n',
      })

      await expect(network.epsRegistration()).rejects.toThrow('AT+CEREG? returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CEREG?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(network.epsRegistration()).rejects.toThrow('Failed to parse AT+CEREG?')
    })
  })

  // ── AT+COPN ─────────────────────────────────────────────────────────────

  describe('operatorNames()', () => {
    it('parses multiple operator entries', async () => {
      transport.autoRespond({
        'AT+COPN\r': [
          '\r\n+COPN: "28301","Orange Armenia"\r\n',
          '+COPN: "28310","Ucom"\r\n',
          '+COPN: "46000","China Mobile Com"\r\n',
          '\r\nOK\r\n',
        ].join(''),
      })

      const names = await network.operatorNames()
      expect(names).toHaveLength(3)
      expect(names[0]).toEqual({ numeric: '28301', name: 'Orange Armenia' })
      expect(names[1]).toEqual({ numeric: '28310', name: 'Ucom' })
      expect(names[2]).toEqual({ numeric: '46000', name: 'China Mobile Com' })
    })

    it('returns empty array when no entries', async () => {
      transport.autoRespond({
        'AT+COPN\r': '\r\nOK\r\n',
      })

      const names = await network.operatorNames()
      expect(names).toHaveLength(0)
    })

    it('skips malformed lines', async () => {
      transport.autoRespond({
        'AT+COPN\r': [
          '\r\n+COPN: "28301","Orange Armenia"\r\n',
          'GARBAGE LINE\r\n',
          '+COPN: "28310","Ucom"\r\n',
          '\r\nOK\r\n',
        ].join(''),
      })

      const names = await network.operatorNames()
      expect(names).toHaveLength(2)
    })
  })

  // ── AT+CPOL ─────────────────────────────────────────────────────────────

  describe('preferredOperators()', () => {
    it('parses preferred operator list with AcT flags', async () => {
      transport.autoRespond({
        'AT+CPOL=,2\r': '\r\nOK\r\n',
        'AT+CPOL?\r': [
          '\r\n+CPOL: 1,2,"28301",0,0,0,1\r\n',
          '+CPOL: 2,2,"28310",1,0,1,1\r\n',
          '+CPOL: 3,2,"46000",0,0,0,1,1\r\n',
          '\r\nOK\r\n',
        ].join(''),
      })

      const operators = await network.preferredOperators()
      expect(operators).toHaveLength(3)

      expect(operators[0]).toEqual({
        index: 1,
        numeric: '28301',
        gsm: false,
        utran: false,
        eutran: true,
        nr: undefined,
      })

      expect(operators[1]).toEqual({
        index: 2,
        numeric: '28310',
        gsm: true,
        utran: true,
        eutran: true,
        nr: undefined,
      })

      // Entry with NR (5G) flag
      expect(operators[2]).toEqual({
        index: 3,
        numeric: '46000',
        gsm: false,
        utran: false,
        eutran: true,
        nr: true,
      })
    })

    it('returns empty array when no preferred operators', async () => {
      transport.autoRespond({
        'AT+CPOL=,2\r': '\r\nOK\r\n',
        'AT+CPOL?\r': '\r\nOK\r\n',
      })

      const operators = await network.preferredOperators()
      expect(operators).toHaveLength(0)
    })
  })

  describe('setPreferredOperator()', () => {
    it('sends correct command with all AcT flags', async () => {
      transport.autoRespond({
        'AT+CPOL=1,2,"28301",1,0,1,1\r': '\r\nOK\r\n',
      })

      await expect(
        network.setPreferredOperator({
          index: 1,
          numeric: '28301',
          gsm: true,
          utran: true,
          eutran: true,
        }),
      ).resolves.toBeUndefined()
    })

    it('defaults AcT flags to 0 when not specified', async () => {
      transport.autoRespond({
        'AT+CPOL=2,2,"28310",0,0,0,0\r': '\r\nOK\r\n',
      })

      await expect(
        network.setPreferredOperator({
          index: 2,
          numeric: '28310',
        }),
      ).resolves.toBeUndefined()
    })

    it('sends LTE-only entry', async () => {
      transport.autoRespond({
        'AT+CPOL=3,2,"46000",0,0,0,1\r': '\r\nOK\r\n',
      })

      await expect(
        network.setPreferredOperator({
          index: 3,
          numeric: '46000',
          eutran: true,
        }),
      ).resolves.toBeUndefined()
    })
  })

  describe('removePreferredOperator()', () => {
    it('sends delete command for given index', async () => {
      transport.autoRespond({
        'AT+CPOL=3\r': '\r\nOK\r\n',
      })

      await expect(network.removePreferredOperator(3)).resolves.toBeUndefined()
    })
  })
})
