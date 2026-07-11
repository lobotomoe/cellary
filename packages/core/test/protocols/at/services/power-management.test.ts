import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { RadioModule } from '../../../../src/protocols/at/services/radio.js'
import { MockTransport } from '../../../../src/transport/mock.js'

function createModule(): { transport: MockTransport; channel: ATChannel; radio: RadioModule } {
  const transport = new MockTransport()
  const channel = new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
  const radio = new RadioModule(channel)
  return { transport, channel, radio }
}

describe('RadioModule -- power management', () => {
  let transport: MockTransport
  let channel: ATChannel
  let radio: RadioModule

  beforeEach(async () => {
    ;({ transport, channel, radio } = createModule())
    await transport.open()
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── PSM ─────────────────────────────────────────────────────────────────

  describe('powerSavingMode()', () => {
    it('parses enabled PSM and decodes timers to seconds', async () => {
      // Periodic-TAU = "01000011" (Timer3: unit=010 -> 10h=36000s, value=00011 -> 3) = 108000s
      // Active-Time  = "00100100" (Timer:  unit=001 -> 1min=60s,   value=00100 -> 4) = 240s
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\n+CPSMS: 1,"01000111","01000001","01000011","00100100"\r\n\r\nOK\r\n',
      })

      const config = await radio.powerSavingMode()
      expect(config.enabled).toBe(true)
      expect(config.sleepDurationSeconds).toBe(108_000) // 30 hours
      expect(config.activeDurationSeconds).toBe(240) // 4 minutes
    })

    it('parses disabled PSM with no timers', async () => {
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\n+CPSMS: 0\r\n\r\nOK\r\n',
      })

      const config = await radio.powerSavingMode()
      expect(config.enabled).toBe(false)
      expect(config.sleepDurationSeconds).toBeUndefined()
      expect(config.activeDurationSeconds).toBeUndefined()
    })

    it('parses active-time only (no TAU or RAU)', async () => {
      // Active-Time = "00100100" -> 4 * 60 = 240s
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\n+CPSMS: 1,,,,"00100100"\r\n\r\nOK\r\n',
      })

      const config = await radio.powerSavingMode()
      expect(config.enabled).toBe(true)
      expect(config.sleepDurationSeconds).toBeUndefined()
      expect(config.activeDurationSeconds).toBe(240)
    })

    it('falls back to RAU when TAU is absent', async () => {
      // Periodic-RAU = "01000111" (Timer: unit=010 -> 6min=360s, value=00111 -> 7) = 2520s
      // 4 commas required: mode,RAU,READY,TAU,Active
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\n+CPSMS: 1,"01000111",,,\r\n\r\nOK\r\n',
      })

      const config = await radio.powerSavingMode()
      expect(config.sleepDurationSeconds).toBe(2520) // 42 minutes
    })

    it('returns undefined for deactivated timers (unit=111)', async () => {
      // Timer with unit 111 = deactivated
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\n+CPSMS: 1,,,,"11100000"\r\n\r\nOK\r\n',
      })

      const config = await radio.powerSavingMode()
      expect(config.activeDurationSeconds).toBeUndefined()
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CPSMS?\r': '\r\nOK\r\n',
      })

      await expect(radio.powerSavingMode()).rejects.toThrow('returned no data')
    })
  })

  describe('setPowerSavingMode()', () => {
    it('sends enable with sleep and active timers', async () => {
      // 240s active -> encodeGprsTimer -> 4 * 60s -> unit=001, value=00100 -> "00100100"
      // 108000s sleep -> encodeGprsTimer3 -> 3 * 36000s -> unit=010, value=00011 -> "01000011"
      transport.autoRespond({
        'AT+CPSMS=1,,,"01000011","00100100"\r': '\r\nOK\r\n',
      })

      await radio.setPowerSavingMode({
        enabled: true,
        sleepDurationSeconds: 108_000,
        activeDurationSeconds: 240,
      })
    })

    it('sends disable without timers', async () => {
      transport.autoRespond({
        'AT+CPSMS=0,,,\r': '\r\nOK\r\n',
      })

      await radio.setPowerSavingMode({ enabled: false })
    })
  })

  describe('resetPowerSavingMode()', () => {
    it('sends mode=2 to reset', async () => {
      transport.autoRespond({
        'AT+CPSMS=2\r': '\r\nOK\r\n',
      })

      await radio.resetPowerSavingMode()
    })
  })

  // ── eDRX ────────────────────────────────────────────────────────────────

  describe('edrxSettings()', () => {
    it('parses and decodes eDRX cycle for E-UTRAN WB', async () => {
      // Code "0010" = 2 -> EUTRAN_WB[2] = 20.48s
      transport.autoRespond({
        'AT+CEDRXS?\r': '\r\n+CEDRXS: 4,"0010"\r\n\r\nOK\r\n',
      })

      const configs = await radio.edrxSettings()
      expect(configs).toHaveLength(1)
      expect(configs[0]?.accessType).toBe('eutranWb')
      expect(configs[0]?.cycleDurationSeconds).toBe(20.48)
    })

    it('parses multiple access technology configs', async () => {
      // WB code "0010" = 20.48s, NB code "0101" = 81.92s
      transport.autoRespond({
        'AT+CEDRXS?\r': '\r\n+CEDRXS: 4,"0010"\r\n' + '+CEDRXS: 5,"0101"\r\n' + '\r\nOK\r\n',
      })

      const configs = await radio.edrxSettings()
      expect(configs).toHaveLength(2)
      expect(configs[0]?.accessType).toBe('eutranWb')
      expect(configs[0]?.cycleDurationSeconds).toBe(20.48)
      expect(configs[1]?.accessType).toBe('eutranNb')
      expect(configs[1]?.cycleDurationSeconds).toBe(81.92)
    })

    it('returns empty array when no configs', async () => {
      transport.autoRespond({
        'AT+CEDRXS?\r': '\r\nOK\r\n',
      })

      const configs = await radio.edrxSettings()
      expect(configs).toHaveLength(0)
    })

    it('skips lines with unknown access type codes', async () => {
      transport.autoRespond({
        'AT+CEDRXS?\r': '\r\n+CEDRXS: 99,"0010"\r\n' + '+CEDRXS: 4,"0010"\r\n' + '\r\nOK\r\n',
      })

      const configs = await radio.edrxSettings()
      expect(configs).toHaveLength(1)
      expect(configs[0]?.accessType).toBe('eutranWb')
    })
  })

  describe('setEdrx()', () => {
    it('encodes seconds to binary code for E-UTRAN WB', async () => {
      // 20.48s -> nearest EUTRAN_WB code = 2 -> "0010"
      transport.autoRespond({
        'AT+CEDRXS=2,4,"0010"\r': '\r\nOK\r\n',
      })

      await radio.setEdrx('eutranWb', 20.48)
    })

    it('encodes seconds to binary code for NB-IoT', async () => {
      // 81.92s -> nearest EUTRAN_NB code = 5 -> "0101"
      transport.autoRespond({
        'AT+CEDRXS=2,5,"0101"\r': '\r\nOK\r\n',
      })

      await radio.setEdrx('eutranNb', 81.92)
    })

    it('finds nearest cycle for approximate seconds', async () => {
      // 20s is closest to 20.48s (code 2) for E-UTRAN WB
      transport.autoRespond({
        'AT+CEDRXS=2,4,"0010"\r': '\r\nOK\r\n',
      })

      await radio.setEdrx('eutranWb', 20)
    })
  })

  describe('disableEdrx()', () => {
    it('sends mode=0', async () => {
      transport.autoRespond({
        'AT+CEDRXS=0\r': '\r\nOK\r\n',
      })

      await radio.disableEdrx()
    })
  })

  describe('resetEdrx()', () => {
    it('sends mode=3 to reset', async () => {
      transport.autoRespond({
        'AT+CEDRXS=3\r': '\r\nOK\r\n',
      })

      await radio.resetEdrx()
    })
  })

  describe('edrxDynamicParams()', () => {
    it('decodes all dynamic params to seconds', async () => {
      // accessType=4 (eutranWb), requested="0010" (20.48s), network="0011" (40.96s), paging="1001" (12.8s)
      transport.autoRespond({
        'AT+CEDRXRDP\r': '\r\n+CEDRXRDP: 4,"0010","0011","1001"\r\n\r\nOK\r\n',
      })

      const params = await radio.edrxDynamicParams()
      expect(params.accessType).toBe('eutranWb')
      expect(params.requestedCycleSeconds).toBe(20.48)
      expect(params.networkCycleSeconds).toBe(40.96)
      expect(params.pagingWindowSeconds).toBe(12.8)
    })

    it('parses minimal response (not using eDRX)', async () => {
      transport.autoRespond({
        'AT+CEDRXRDP\r': '\r\n+CEDRXRDP: 0\r\n\r\nOK\r\n',
      })

      const params = await radio.edrxDynamicParams()
      expect(params.accessType).toBe('none')
      expect(params.requestedCycleSeconds).toBeUndefined()
      expect(params.networkCycleSeconds).toBeUndefined()
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CEDRXRDP\r': '\r\nOK\r\n',
      })

      await expect(radio.edrxDynamicParams()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on unknown access type', async () => {
      transport.autoRespond({
        'AT+CEDRXRDP\r': '\r\n+CEDRXRDP: 99\r\n\r\nOK\r\n',
      })

      await expect(radio.edrxDynamicParams()).rejects.toThrow('Unknown eDRX access type')
    })
  })

  // ── Signalling Connection ───────────────────────────────────────────────

  describe('signallingConnection()', () => {
    it('parses idle mode', async () => {
      transport.autoRespond({
        'AT+CSCON?\r': '\r\n+CSCON: 1,0\r\n\r\nOK\r\n',
      })

      const status = await radio.signallingConnection()
      expect(status.mode).toBe('idle')
    })

    it('parses connected mode', async () => {
      transport.autoRespond({
        'AT+CSCON?\r': '\r\n+CSCON: 1,1\r\n\r\nOK\r\n',
      })

      const status = await radio.signallingConnection()
      expect(status.mode).toBe('connected')
    })

    it('parses connected mode with state detail (ignored at domain level)', async () => {
      transport.autoRespond({
        'AT+CSCON?\r': '\r\n+CSCON: 2,1,7\r\n\r\nOK\r\n',
      })

      const status = await radio.signallingConnection()
      expect(status.mode).toBe('connected')
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CSCON?\r': '\r\nOK\r\n',
      })

      await expect(radio.signallingConnection()).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CSCON?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(radio.signallingConnection()).rejects.toThrow('Failed to parse')
    })
  })
})
