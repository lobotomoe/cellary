import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { CapabilitiesModule } from '../../../../src/protocols/at/services/capabilities.js'
import { MockTransport } from '../../../../src/transport/mock.js'
import type { AtConfig } from '../../../../src/types.js'

const genericAtConfig = requireAtConfig(genericProfile)

// Profile with Huawei-style vendor capability checks.
// The E3372 CLAC response contains vendor commands (^ICCID, ^STSF, ^STGI)
// which are only recognized when the profile declares them.
const huaweiTestProfile: AtConfig = {
  ...genericAtConfig,
  capabilityChecks: {
    iccid: ['^ICCID', '^SCID'],
    stk: ['^STSF', '^STGI'],
  },
}

// Realistic AT+CLAC response from Huawei E3372 (subset for testing)
const E3372_CLAC_RESPONSE = [
  'H',
  'A',
  'D',
  '+CMGS',
  '+CMGL',
  '+CMGR',
  '+CMGD',
  '+CMGF',
  '+CSMS',
  '+CNMI',
  '+CPMS',
  '+CMMS',
  '+CHUP',
  '+CLCC',
  '+CHLD',
  '+VTS',
  '+CCFC',
  '+CCWA',
  '+CLIP',
  '+CSQ',
  '+CREG',
  '+CGREG',
  '+CEREG',
  '+COPS',
  '+CIMI',
  '^ICCID',
  '+CPIN',
  '+CPBR',
  '+CSIM',
  '+CRSM',
  '+CUSD',
  '+CGDCONT',
  '+CGACT',
  '+CGPADDR',
  '+CLAC',
  '^STSF',
  '^STGI',
  '^STGR',
].join(' | ')

describe('CapabilitiesModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let capabilities: CapabilitiesModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: genericAtConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    capabilities = new CapabilitiesModule(channel, huaweiTestProfile)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('discover()', () => {
    it('discovers full capabilities from AT+CLAC', async () => {
      transport.autoRespond({
        'AT+CLAC\r': `\r\n${E3372_CLAC_RESPONSE}\r\n\r\nOK\r\n`,
        'AT+CMGF=?\r': '\r\n+CMGF: (0,1)\r\n\r\nOK\r\n',
        'AT+CPMS=?\r': '\r\n+CPMS: ("SM","ME"),("SM","ME"),("SM","ME")\r\n\r\nOK\r\n',
        'AT+CGDCONT=?\r': [
          '\r\n+CGDCONT: (0-31),"IP",,,(0-2),(0-3),(0,1),(0,1),(0-2),(0,1)\r\n',
          '+CGDCONT: (0-31),"PPP",,,(0-2),(0-3),(0,1),(0,1),(0-2),(0,1)\r\n',
          '\r\nOK\r\n',
        ].join(''),
      })

      const caps = await capabilities.discover()

      // Commands
      expect(caps.commands.length).toBeGreaterThan(30)
      expect(caps.commands).toContain('+CMGS')
      expect(caps.commands).toContain('^ICCID')

      // SMS
      expect(caps.sms.send).toBe(true)
      expect(caps.sms.receive).toBe(true)
      expect(caps.sms.read).toBe(true)
      expect(caps.sms.delete).toBe(true)
      expect(caps.sms.multipart).toBe(true)
      expect(caps.sms.modes).toEqual(['pdu', 'text'])
      expect(caps.sms.storage).toEqual(['SM', 'ME'])

      // Voice
      expect(caps.voice.dial).toBe(true)
      expect(caps.voice.answer).toBe(true)
      expect(caps.voice.hangup).toBe(true)
      expect(caps.voice.dtmf).toBe(true)
      expect(caps.voice.forwarding).toBe(true)
      expect(caps.voice.waiting).toBe(true)
      expect(caps.voice.hold).toBe(true)
      expect(caps.voice.callerId).toBe(true)

      // Network
      expect(caps.network.signal).toBe(true)
      expect(caps.network.registration).toBe(true)
      expect(caps.network.operatorScan).toBe(true)
      expect(caps.network.gprs).toBe(true)
      expect(caps.network.eps).toBe(true)

      // SIM
      expect(caps.sim.imsi).toBe(true)
      expect(caps.sim.iccid).toBe(true)
      expect(caps.sim.pin).toBe(true)
      expect(caps.sim.phonebook).toBe(true)
      expect(caps.sim.genericAccess).toBe(true)
      expect(caps.sim.restrictedAccess).toBe(true)

      // USSD
      expect(caps.ussd.supported).toBe(true)

      // Data
      expect(caps.data.pdpContext).toBe(true)
      expect(caps.data.types).toEqual(['IP', 'PPP'])

      // STK
      expect(caps.stk.supported).toBe(true)
    })

    it('returns all-false when AT+CLAC is not supported', async () => {
      transport.autoRespond({
        'AT+CLAC\r': '\r\nERROR\r\n',
      })

      const caps = await capabilities.discover()

      expect(caps.commands).toEqual([])
      expect(caps.sms.send).toBe(false)
      expect(caps.sms.receive).toBe(false)
      expect(caps.sms.modes).toEqual([])
      expect(caps.sms.storage).toEqual([])
      expect(caps.voice.dial).toBe(false)
      expect(caps.network.signal).toBe(false)
      expect(caps.sim.imsi).toBe(false)
      expect(caps.ussd.supported).toBe(false)
      expect(caps.data.pdpContext).toBe(false)
      expect(caps.data.types).toEqual([])
      expect(caps.stk.supported).toBe(false)
    })

    it('handles partial command support', async () => {
      // Modem that only supports SMS and network, no voice/data
      const partialClac = [
        '+CMGS',
        '+CMGL',
        '+CMGD',
        '+CNMI',
        '+CMGF',
        '+CSQ',
        '+CREG',
        '+CIMI',
        '+CPIN',
      ].join(' | ')

      transport.autoRespond({
        'AT+CLAC\r': `\r\n${partialClac}\r\n\r\nOK\r\n`,
        'AT+CMGF=?\r': '\r\n+CMGF: (0)\r\n\r\nOK\r\n',
        'AT+CPMS=?\r': '\r\n+CPMS: ("SM"),("SM"),("SM")\r\n\r\nOK\r\n',
      })

      const caps = await capabilities.discover()

      // SMS partially supported
      expect(caps.sms.send).toBe(true)
      expect(caps.sms.receive).toBe(true)
      expect(caps.sms.read).toBe(true)
      expect(caps.sms.delete).toBe(true)
      expect(caps.sms.multipart).toBe(false)
      expect(caps.sms.modes).toEqual(['pdu'])
      expect(caps.sms.storage).toEqual(['SM'])

      // Voice not supported
      expect(caps.voice.dial).toBe(false)
      expect(caps.voice.dtmf).toBe(false)
      expect(caps.voice.hold).toBe(false)

      // Network partial
      expect(caps.network.signal).toBe(true)
      expect(caps.network.registration).toBe(true)
      expect(caps.network.gprs).toBe(false)
      expect(caps.network.eps).toBe(false)

      // SIM partial
      expect(caps.sim.imsi).toBe(true)
      expect(caps.sim.pin).toBe(true)
      expect(caps.sim.iccid).toBe(false)
      expect(caps.sim.phonebook).toBe(false)

      // USSD not supported
      expect(caps.ussd.supported).toBe(false)

      // Data not supported
      expect(caps.data.pdpContext).toBe(false)
      expect(caps.data.types).toEqual([])
    })

    it('handles enrichment probe failures gracefully', async () => {
      transport.autoRespond({
        'AT+CLAC\r': `\r\n+CMGS | +CNMI | +CMGL | +CMGD | +CMGF | +CPMS | +CGDCONT\r\n\r\nOK\r\n`,
        // SMS mode probe fails
        'AT+CMGF=?\r': '\r\nERROR\r\n',
        // Storage probe succeeds
        'AT+CPMS=?\r': '\r\n+CPMS: ("ME"),("ME"),("ME")\r\n\r\nOK\r\n',
        // PDP probe fails
        'AT+CGDCONT=?\r': '\r\nERROR\r\n',
      })

      const caps = await capabilities.discover()

      // SMS features detected from CLAC
      expect(caps.sms.send).toBe(true)
      expect(caps.sms.read).toBe(true)

      // Failed probes return empty arrays
      expect(caps.sms.modes).toEqual([])
      expect(caps.sms.storage).toEqual(['ME'])
      expect(caps.data.types).toEqual([])
    })

    it('parses range format in SMS modes', async () => {
      transport.autoRespond({
        'AT+CLAC\r': '\r\n+CMGS | +CMGF\r\n\r\nOK\r\n',
        'AT+CMGF=?\r': '\r\n+CMGF: (0-1)\r\n\r\nOK\r\n',
      })

      const caps = await capabilities.discover()
      expect(caps.sms.modes).toEqual(['pdu', 'text'])
    })

    it('handles CLAC with one-command-per-line format', async () => {
      transport.autoRespond({
        'AT+CLAC\r': '\r\n+CMGS\r\n+CSQ\r\n+COPS\r\n\r\nOK\r\n',
      })

      const caps = await capabilities.discover()
      expect(caps.commands).toContain('+CMGS')
      expect(caps.commands).toContain('+CSQ')
      expect(caps.commands).toContain('+COPS')
      expect(caps.sms.send).toBe(true)
      expect(caps.network.signal).toBe(true)
      expect(caps.network.operatorScan).toBe(true)
    })

    it('does not swallow URC-prefixed commands in CLAC response', async () => {
      // Commands like +CREG, +CUSD, +CPIN are registered as URC prefixes.
      // When they appear one-per-line in AT+CLAC output, suppressURC
      // prevents the parser from misclassifying them as URCs.
      transport.autoRespond({
        'AT+CLAC\r':
          '\r\n+CREG\r\n+CGREG\r\n+CEREG\r\n+CUSD\r\n+CPIN\r\n+CLIP\r\n+CSQ\r\n\r\nOK\r\n',
      })

      const caps = await capabilities.discover()
      expect(caps.commands).toContain('+CREG')
      expect(caps.commands).toContain('+CGREG')
      expect(caps.commands).toContain('+CEREG')
      expect(caps.commands).toContain('+CUSD')
      expect(caps.commands).toContain('+CPIN')
      expect(caps.commands).toContain('+CLIP')
      expect(caps.network.registration).toBe(true)
      expect(caps.network.gprs).toBe(true)
      expect(caps.network.eps).toBe(true)
      expect(caps.ussd.supported).toBe(true)
      expect(caps.sim.pin).toBe(true)
      expect(caps.voice.callerId).toBe(true)
    })

    it('detects ICCID via vendor ^ICCID command', async () => {
      transport.autoRespond({
        'AT+CLAC\r': '\r\n^ICCID | +CIMI\r\n\r\nOK\r\n',
      })

      const caps = await capabilities.discover()
      expect(caps.sim.iccid).toBe(true)
      expect(caps.sim.imsi).toBe(true)
    })

    it('skips enrichment probes when features not detected', async () => {
      // No SMS or data commands -> no enrichment probes sent
      transport.autoRespond({
        'AT+CLAC\r': '\r\n+CSQ | +CREG\r\n\r\nOK\r\n',
        // These should NOT be called:
        // 'AT+CMGF=?\r': ...
        // 'AT+CPMS=?\r': ...
        // 'AT+CGDCONT=?\r': ...
      })

      const caps = await capabilities.discover()
      expect(caps.sms.send).toBe(false)
      expect(caps.sms.modes).toEqual([])
      expect(caps.sms.storage).toEqual([])
      expect(caps.data.pdpContext).toBe(false)
      expect(caps.data.types).toEqual([])
    })
  })
})
