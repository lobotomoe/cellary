import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATChannel } from '../../src/protocols/at/channel/at-channel.js'
import { MockTransport } from '../../src/transport/mock.js'

describe('URC interleaving', () => {
  let transport: MockTransport
  let channel: ATChannel

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: ['+CMTI', '+CREG', '+CEREG', 'RING'],
      defaultTimeout: 5000,
    })
  })

  afterEach(() => {
    channel.dispose()
  })

  it('separates URC from command response when URC arrives mid-response', async () => {
    const urcHandler = vi.fn()
    channel.onURC('+CMTI', urcHandler)

    const promise = channel.execute('AT+CSQ')

    // Real-world scenario: URC arrives between info response and OK
    transport.receive('\r\n+CSQ: 18,99\r\n')
    transport.receive('\r\n+CMTI: "SM",3\r\n')
    transport.receive('\r\nOK\r\n')

    const result = await promise

    // Command result should only contain the CSQ response
    expect(result.lines).toEqual(['+CSQ: 18,99'])
    expect(result.status.type).toBe('ok')

    // URC should have been dispatched separately
    expect(urcHandler).toHaveBeenCalledOnce()
    expect(urcHandler).toHaveBeenCalledWith({
      prefix: '+CMTI',
      body: '"SM",3',
      raw: '+CMTI: "SM",3',
    })
  })

  it('handles multiple URCs during one command', async () => {
    const cmtiHandler = vi.fn()
    const cregHandler = vi.fn()
    channel.onURC('+CMTI', cmtiHandler)
    channel.onURC('+CREG', cregHandler)

    const promise = channel.execute('AT+COPS=?')

    // Multiple URCs during a slow command
    transport.receive('\r\n+CMTI: "SM",1\r\n')
    transport.receive('\r\n+CREG: 1,"00A1","1A2B"\r\n')
    transport.receive('\r\n+CMTI: "SM",2\r\n')
    transport.receive('\r\n+COPS: (2,"T-Mobile","TMo","31026",7)\r\n')
    transport.receive('\r\nOK\r\n')

    const result = await promise

    expect(result.lines).toEqual(['+COPS: (2,"T-Mobile","TMo","31026",7)'])
    expect(cmtiHandler).toHaveBeenCalledTimes(2)
    expect(cregHandler).toHaveBeenCalledTimes(1)
  })

  it('handles RING URC while executing a command', async () => {
    const ringHandler = vi.fn()
    channel.onURC('RING', ringHandler)

    const promise = channel.execute('AT+CSQ')

    transport.receive('\r\nRING\r\n')
    transport.receive('\r\n+CSQ: 25,99\r\n')
    transport.receive('\r\nOK\r\n')

    const result = await promise

    expect(result.lines).toEqual(['+CSQ: 25,99'])
    expect(ringHandler).toHaveBeenCalledOnce()
  })

  it('handles URCs arriving in same chunk as command response', async () => {
    const urcHandler = vi.fn()
    channel.onURC('+CMTI', urcHandler)

    const promise = channel.execute('AT+CSQ')

    // All data arrives in a single chunk
    transport.receive('\r\n+CSQ: 18,99\r\n+CMTI: "SM",5\r\nOK\r\n')

    const result = await promise

    expect(result.lines).toEqual(['+CSQ: 18,99'])
    expect(urcHandler).toHaveBeenCalledOnce()
  })

  it('delivers URCs to multiple queued commands correctly', async () => {
    const urcHandler = vi.fn()
    channel.onURC('+CMTI', urcHandler)

    const p1 = channel.execute('AT+CSQ')
    const p2 = channel.execute('AT+CREG?')

    // URC during first command
    transport.receive('\r\n+CMTI: "SM",1\r\n')
    transport.receive('\r\n+CSQ: 18,99\r\n\r\nOK\r\n')

    const r1 = await p1
    expect(r1.lines).toEqual(['+CSQ: 18,99'])

    // URC during second command
    transport.receive('\r\n+CMTI: "SM",2\r\n')
    transport.receive('\r\n+CREG: 1\r\n\r\nOK\r\n')

    const r2 = await p2
    expect(r2.lines).toEqual(['+CREG: 1'])

    expect(urcHandler).toHaveBeenCalledTimes(2)
  })
})
