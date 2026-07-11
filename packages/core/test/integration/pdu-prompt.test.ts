import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimeoutError } from '../../src/errors.js'
import { ATChannel } from '../../src/protocols/at/channel/at-channel.js'
import { MockTransport } from '../../src/transport/mock.js'

describe('PDU prompt state transitions', () => {
  let transport: MockTransport
  let channel: ATChannel

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: ['+CMTI'],
      defaultTimeout: 5000,
    })
  })

  afterEach(() => {
    channel.dispose()
  })

  it('transitions: idle → awaiting_prompt → data_input → idle', async () => {
    const pdu = 'AABBCCDD'
    const promise = channel.execute('AT+CMGS=4', {
      expectsPrompt: true,
      promptData: pdu,
    })

    // State: awaiting_prompt
    expect(transport.written).toEqual(['AT+CMGS=4\r'])

    // Modem sends prompt
    transport.receive('\r\n> ')

    // Wait for async processing
    await vi.waitFor(() => {
      expect(transport.written).toContain(`${pdu}\x1a`)
    })

    // State: data_input — now send final result
    transport.receive('\r\n+CMGS: 1\r\n\r\nOK\r\n')

    const result = await promise
    expect(result.status.type).toBe('ok')
    expect(result.lines).toEqual(['+CMGS: 1'])
  })

  it('handles prompt arriving in chunks', async () => {
    const promise = channel.execute('AT+CMGS=4', {
      expectsPrompt: true,
      promptData: 'AABB',
    })

    // Prompt arrives in pieces
    transport.receive('\r\n>')
    // PDU data should NOT be sent yet (prompt incomplete)
    expect(transport.written).toEqual(['AT+CMGS=4\r'])

    transport.receive(' ')

    await vi.waitFor(() => {
      expect(transport.written).toContain('AABB\x1a')
    })

    transport.receive('\r\n+CMGS: 1\r\n\r\nOK\r\n')
    const result = await promise
    expect(result.status.type).toBe('ok')
  })

  it('handles URC during prompt wait', async () => {
    const handler = vi.fn()
    channel.onURC('+CMTI', handler)

    const promise = channel.execute('AT+CMGS=4', {
      expectsPrompt: true,
      promptData: 'AABB',
    })

    // URC arrives before prompt
    transport.receive('\r\n+CMTI: "SM",5\r\n')
    expect(handler).toHaveBeenCalledOnce()

    // Then prompt arrives
    transport.receive('\r\n> ')
    await vi.waitFor(() => {
      expect(transport.written).toContain('AABB\x1a')
    })

    transport.receive('\r\n+CMGS: 1\r\n\r\nOK\r\n')
    const result = await promise
    expect(result.status.type).toBe('ok')
  })

  it('times out if prompt never arrives', async () => {
    const promise = channel.execute('AT+CMGS=4', {
      expectsPrompt: true,
      promptData: 'AABB',
      timeout: 50,
    })

    // No prompt sent — should timeout
    await expect(promise).rejects.toThrow(TimeoutError)
  })

  it('queued commands execute after prompt command completes', async () => {
    const p1 = channel.execute('AT+CMGS=4', {
      expectsPrompt: true,
      promptData: 'AABB',
    })
    const p2 = channel.execute('AT+CSQ')

    // Only first command should be sent
    expect(transport.written).toEqual(['AT+CMGS=4\r'])

    // Complete prompt flow
    transport.receive('\r\n> ')
    await vi.waitFor(() => {
      expect(transport.written).toContain('AABB\x1a')
    })
    transport.receive('\r\n+CMGS: 1\r\n\r\nOK\r\n')

    await p1

    // Now CSQ should be sent
    expect(transport.written).toContain('AT+CSQ\r')

    transport.receive('\r\n+CSQ: 18,99\r\n\r\nOK\r\n')
    const r2 = await p2
    expect(r2.lines).toEqual(['+CSQ: 18,99'])
  })
})
