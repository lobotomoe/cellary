import { describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { RadioModule } from '../../../../src/protocols/at/services/radio.js'
import { MockTransport } from '../../../../src/transport/mock.js'

function createChannel(transport: MockTransport): ATChannel {
  return new ATChannel(transport, { urcPrefixes: [], defaultTimeout: 5000 })
}

describe('RadioModule', () => {
  describe('functionality()', () => {
    it('parses full functionality mode (1)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 1\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('full')
    })

    it('parses minimum functionality mode (0)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 0\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('minimum')
    })

    it('parses airplane mode (4)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 4\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('airplane')
    })

    it('parses TX disabled mode (2)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 2\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('txDisabled')
    })

    it('parses RX disabled mode (3)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 3\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('rxDisabled')
    })

    it('parses shutdown mode (129)', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 129\r\n\r\nOK\r\n',
      })
      await transport.open()

      expect(await radio.functionality()).toBe('shutdown')
    })

    it('throws on unknown manufacturer-specific mode', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\n+CFUN: 7\r\n\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.functionality()).rejects.toThrow('Unknown CFUN mode 7')
    })

    it('throws when response has no data', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN?\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.functionality()).rejects.toThrow('returned no data')
    })
  })

  describe('setFunctionality()', () => {
    it('sends AT+CFUN=1 for full mode', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN=1\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.setFunctionality('full')).resolves.toBeUndefined()
    })

    it('sends AT+CFUN=0 for minimum mode', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN=0\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.setFunctionality('minimum')).resolves.toBeUndefined()
    })

    it('sends AT+CFUN=4 for airplane mode', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN=4\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.setFunctionality('airplane')).resolves.toBeUndefined()
    })

    it('sends AT+CFUN=1,1 with reset flag', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN=1,1\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.setFunctionality('full', true)).resolves.toBeUndefined()
    })

    it('sends AT+CFUN=129 for shutdown mode', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CFUN=129\r': '\r\nOK\r\n',
      })
      await transport.open()

      await expect(radio.setFunctionality('shutdown')).resolves.toBeUndefined()
    })
  })

  describe('lastError()', () => {
    it('parses standard text report', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CEER\r': '\r\n+CEER: Normal call clearing\r\n\r\nOK\r\n',
      })
      await transport.open()

      const report = await radio.lastError()
      expect(report.report).toBe('Normal call clearing')
    })

    it('parses "No report available" response', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CEER\r': '\r\n+CEER: No report available\r\n\r\nOK\r\n',
      })
      await transport.open()

      const report = await radio.lastError()
      expect(report.report).toBe('No report available')
    })

    it('handles empty response gracefully', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CEER\r': '\r\nOK\r\n',
      })
      await transport.open()

      const report = await radio.lastError()
      expect(report.report).toBe('No report available')
    })

    it('parses user busy cause', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      transport.autoRespond({
        'AT+CEER\r': '\r\n+CEER: User busy\r\n\r\nOK\r\n',
      })
      await transport.open()

      const report = await radio.lastError()
      expect(report.report).toBe('User busy')
    })

    it('handles non-standard response format', async () => {
      const transport = new MockTransport()
      const channel = createChannel(transport)
      const radio = new RadioModule(channel)

      // Some vendors return cause without +CEER: prefix after OK
      transport.autoRespond({
        'AT+CEER\r': '\r\nSome raw error text\r\n\r\nOK\r\n',
      })
      await transport.open()

      const report = await radio.lastError()
      expect(report.report).toBe('Some raw error text')
    })
  })
})
