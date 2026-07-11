import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATError } from '../../src/errors.js'
import { ATChannel } from '../../src/protocols/at/channel/at-channel.js'
import { MockTransport } from '../../src/transport/mock.js'

describe('SMS send conversation', () => {
  let transport: MockTransport
  let channel: ATChannel

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, { defaultTimeout: 5000 })
  })

  afterEach(() => {
    channel.dispose()
  })

  it('completes a full text-mode SMS send', async () => {
    // 1. Switch to text mode
    const p1 = channel.execute('AT+CMGF=1')
    transport.receive('\r\nOK\r\n')
    await p1

    // 2. Send SMS with prompt
    const p2 = channel.execute('AT+CMGS="+1234567890"', {
      expectsPrompt: true,
      promptData: 'Hello from cellary',
      timeout: 30_000,
    })

    // Modem echoes and sends prompt
    transport.receive('\r\n> ')

    // Wait for the prompt data to be written
    await new Promise((r) => setTimeout(r, 10))

    // Verify prompt data was sent with Ctrl-Z
    expect(transport.written).toContain('Hello from cellary\x1a')

    // Modem responds with message reference
    transport.receive('\r\n+CMGS: 42\r\n\r\nOK\r\n')

    const result = await p2
    expect(result.status.type).toBe('ok')
    expect(result.lines).toEqual(['+CMGS: 42'])
  })

  it('completes a PDU-mode SMS send', async () => {
    const pdu = '0011000B916407281553F80000AA0CC8329BFD06DDDF723619'

    const promise = channel.execute('AT+CMGS=23', {
      expectsPrompt: true,
      promptData: pdu,
      timeout: 30_000,
    })

    // Prompt arrives
    transport.receive('\r\n> ')
    await new Promise((r) => setTimeout(r, 10))

    // Verify PDU + Ctrl-Z
    expect(transport.written).toContain(`${pdu}\x1a`)

    // Success response
    transport.receive('\r\n+CMGS: 99\r\n\r\nOK\r\n')

    const result = await promise
    expect(result.status.type).toBe('ok')
    expect(result.lines).toEqual(['+CMGS: 99'])
  })

  it('handles SMS send failure', async () => {
    const promise = channel.execute('AT+CMGS=23', {
      expectsPrompt: true,
      promptData: '00112233',
      timeout: 30_000,
    })

    transport.receive('\r\n> ')
    await new Promise((r) => setTimeout(r, 10))

    // Network error
    transport.receive('\r\n+CMS ERROR: 500\r\n')

    await expect(promise).rejects.toThrow(ATError)
    await expect(promise).rejects.toMatchObject({
      result: { type: 'cms_error', code: 500 },
    })
  })
})
