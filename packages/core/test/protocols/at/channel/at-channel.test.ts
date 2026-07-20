import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditRecord } from '../../../../src/audit.js'
import { ATError, ChannelDisposedError, TimeoutError } from '../../../../src/errors.js'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { MockTransport } from '../../../../src/transport/mock.js'

describe('ATChannel', () => {
  let transport: MockTransport
  let channel: ATChannel

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: ['+CMTI', '+CREG', 'RING'],
      defaultTimeout: 5000,
    })
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('basic command execution', () => {
    it('executes a simple AT command', async () => {
      const promise = channel.execute('AT')
      transport.receive('\r\nOK\r\n')

      const result = await promise
      expect(result.command).toBe('AT')
      expect(result.status.type).toBe('ok')
      expect(result.lines).toEqual([])
    })

    it('sends the command with \\r terminator', async () => {
      const promise = channel.execute('AT')
      transport.receive('\r\nOK\r\n')
      await promise

      expect(transport.written).toContain('AT\r')
    })

    it('collects info response lines', async () => {
      const promise = channel.execute('AT+CSQ')
      transport.receive('\r\n+CSQ: 18,99\r\n\r\nOK\r\n')

      const result = await promise
      expect(result.status.type).toBe('ok')
      expect(result.lines).toEqual(['+CSQ: 18,99'])
    })

    it('handles echo before response', async () => {
      const promise = channel.execute('AT+CSQ')
      // Modem echoes command (before ATE0), then responds
      transport.receive('AT+CSQ\r\n+CSQ: 18,99\r\n\r\nOK\r\n')

      const result = await promise
      expect(result.lines).toEqual(['+CSQ: 18,99'])
    })

    it('rejects with ATError on ERROR response', async () => {
      const promise = channel.execute('AT+INVALID')
      transport.receive('\r\nERROR\r\n')

      await expect(promise).rejects.toThrow(ATError)
      await expect(promise).rejects.toMatchObject({ result: { type: 'error' } })
    })

    it('rejects with ATError on +CME ERROR response', async () => {
      const promise = channel.execute('AT+CPIN?')
      transport.receive('\r\n+CME ERROR: 10\r\n')

      await expect(promise).rejects.toThrow(ATError)
      await expect(promise).rejects.toMatchObject({
        result: { type: 'cme_error', code: 10 },
      })
    })
  })

  describe('command queue serialization', () => {
    it('executes commands sequentially', async () => {
      const p1 = channel.execute('AT+CSQ')
      const p2 = channel.execute('AT+CREG?')

      // Only first command should be sent initially
      expect(transport.written).toEqual(['AT+CSQ\r'])

      // Respond to first command
      transport.receive('\r\n+CSQ: 18,99\r\n\r\nOK\r\n')
      const r1 = await p1

      // Now second command should be sent
      expect(transport.written).toEqual(['AT+CSQ\r', 'AT+CREG?\r'])

      // Respond to second command
      transport.receive('\r\n+CREG: 1\r\n\r\nOK\r\n')
      const r2 = await p2

      expect(r1.lines).toEqual(['+CSQ: 18,99'])
      expect(r2.lines).toEqual(['+CREG: 1'])
    })
  })

  describe('timeouts', () => {
    it('rejects on timeout', async () => {
      const promise = channel.execute('AT+SLOW', { timeout: 50 })

      await expect(promise).rejects.toThrow(TimeoutError)
    })

    it('processes next command after timeout (resync on echo)', async () => {
      const p1 = channel.execute('AT+SLOW', { timeout: 50 })
      const p2 = channel.execute('AT')

      await expect(p1).rejects.toThrow(TimeoutError)

      // Echo is on: p2's echo re-aligns the channel after the timeout, then its
      // OK resolves it. A bare OK (no echo) would be treated as p1's late
      // response and discarded — see the AT-C1 tests below.
      transport.receive('AT\r\nOK\r\n')
      const r2 = await p2
      expect(r2.status.type).toBe('ok')
    })

    it('discards a timed-out command late response instead of resolving the next (AT-C1)', async () => {
      const p1 = channel.execute('AT+SLOW', { timeout: 50 })
      const p2 = channel.execute('AT+CSQ')
      await expect(p1).rejects.toThrow(TimeoutError)

      // p1's late response arrives first (no echo — it is stale). It must not
      // resolve or pollute p2.
      transport.receive('\r\n+SLOW: 1\r\n\r\nOK\r\n')

      let settled = false
      p2.then(() => {
        settled = true
      }).catch(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)

      // p2's own echo resyncs, then its response resolves it with p2's data.
      transport.receive('AT+CSQ\r\n+CSQ: 5,99\r\n\r\nOK\r\n')
      const r2 = await p2
      expect(r2.lines).toEqual(['+CSQ: 5,99'])
    })

    it('gives up resyncing if the next command also times out (non-echoing device)', async () => {
      // A device that does not echo would otherwise wedge every command after a
      // timeout. After one command times out while resyncing, the channel stops
      // discarding so a later response resolves normally.
      const p1 = channel.execute('AT+A', { timeout: 40 })
      await expect(p1).rejects.toThrow(TimeoutError)
      const p2 = channel.execute('AT+B', { timeout: 40 })
      await expect(p2).rejects.toThrow(TimeoutError)

      const p3 = channel.execute('AT+CSQ')
      // Bare response, no echo — must still resolve p3 (resync was abandoned).
      transport.receive('\r\n+CSQ: 7,99\r\n\r\nOK\r\n')
      const r3 = await p3
      expect(r3.lines).toEqual(['+CSQ: 7,99'])
    })
  })

  describe('URC handling', () => {
    it('dispatches URCs while idle', async () => {
      const handler = vi.fn()
      channel.onURC('+CMTI', handler)

      transport.receive('\r\n+CMTI: "SM",3\r\n')

      expect(handler).toHaveBeenCalledWith({
        prefix: '+CMTI',
        body: '"SM",3',
        raw: '+CMTI: "SM",3',
      })
    })

    it('dispatches URCs during a command (interleaving)', async () => {
      const handler = vi.fn()
      channel.onURC('+CMTI', handler)

      const promise = channel.execute('AT+CSQ')

      // URC arrives between info response and OK
      transport.receive('\r\n+CSQ: 18,99\r\n')
      transport.receive('\r\n+CMTI: "SM",3\r\n')
      transport.receive('\r\nOK\r\n')

      const result = await promise

      // Command result should only have the info response
      expect(result.lines).toEqual(['+CSQ: 18,99'])

      // URC handler should have been called
      expect(handler).toHaveBeenCalledWith({
        prefix: '+CMTI',
        body: '"SM",3',
        raw: '+CMTI: "SM",3',
      })
    })

    it('supports unsubscribe', () => {
      const handler = vi.fn()
      const unsub = channel.onURC('+CMTI', handler)

      transport.receive('\r\n+CMTI: "SM",1\r\n')
      expect(handler).toHaveBeenCalledTimes(1)

      unsub()
      transport.receive('\r\n+CMTI: "SM",2\r\n')
      expect(handler).toHaveBeenCalledTimes(1) // Still 1, not 2
    })

    it('dispatches to catch-all handler', () => {
      const handler = vi.fn()
      channel.onAnyURC(handler)

      transport.receive('\r\n+CREG: 1\r\n')
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('dispatches RING URC', () => {
      const handler = vi.fn()
      channel.onURC('RING', handler)

      transport.receive('\r\nRING\r\n')
      expect(handler).toHaveBeenCalledWith({
        prefix: 'RING',
        body: '',
        raw: 'RING',
      })
    })
  })

  describe('prompt handling (SMS PDU)', () => {
    it('handles prompt flow for SMS send', async () => {
      const promise = channel.execute('AT+CMGS=23', {
        expectsPrompt: true,
        promptData: '0011000B916407281553F80000AA0CC8329BFD06DDDF723619',
      })

      // Modem sends prompt
      transport.receive('\r\n> ')

      // Channel should have written the PDU data + Ctrl-Z
      await vi.waitFor(() => {
        expect(transport.written).toContain(
          '0011000B916407281553F80000AA0CC8329BFD06DDDF723619\x1a',
        )
      })

      // Modem responds with success
      transport.receive('\r\n+CMGS: 42\r\n\r\nOK\r\n')

      const result = await promise
      expect(result.status.type).toBe('ok')
      expect(result.lines).toEqual(['+CMGS: 42'])
    })
  })

  describe('dispose', () => {
    it('rejects pending commands', async () => {
      const promise = channel.execute('AT+SLOW')
      channel.dispose()

      await expect(promise).rejects.toThrow(ChannelDisposedError)
    })

    it('rejects queued commands', async () => {
      const p1 = channel.execute('AT+SLOW')
      const p2 = channel.execute('AT')
      channel.dispose()

      await expect(p1).rejects.toThrow(ChannelDisposedError)
      await expect(p2).rejects.toThrow(ChannelDisposedError)
    })

    it('rejects new commands after dispose', async () => {
      channel.dispose()
      await expect(channel.execute('AT')).rejects.toThrow(ChannelDisposedError)
    })
  })

  describe('chunked data', () => {
    it('handles response arriving byte by byte', async () => {
      const promise = channel.execute('AT')

      for (const ch of '\r\nOK\r\n') {
        transport.receive(ch)
      }

      const result = await promise
      expect(result.status.type).toBe('ok')
    })
  })

  describe('audit sink', () => {
    async function channelWithAudit(records: AuditRecord[], defaultTimeout = 5000) {
      const t = new MockTransport()
      await t.open()
      const ch = new ATChannel(t, {
        defaultTimeout,
        auditSink: { record: (r) => records.push(r) },
      })
      return { t, ch }
    }

    it('emits a masked tx record and rx records for one exchange', async () => {
      const records: AuditRecord[] = []
      const { t, ch } = await channelWithAudit(records)

      const promise = ch.execute('AT+CSQ')
      t.receive('\r\n+CSQ: 18,99\r\n\r\nOK\r\n')
      await promise
      ch.dispose()

      const tx = records.filter((r) => r.direction === 'tx')
      const rx = records.filter((r) => r.direction === 'rx')
      expect(tx).toHaveLength(1)
      expect(tx[0]).toMatchObject({ protocol: 'at', direction: 'tx', text: 'AT+CSQ' })
      expect(rx.some((r) => r.text.includes('+CSQ: 18,99'))).toBe(true)
      expect(rx.some((r) => r.text.includes('OK'))).toBe(true)
    })

    it('masks a SIM PIN in the audited command', async () => {
      const records: AuditRecord[] = []
      const { t, ch } = await channelWithAudit(records)

      const promise = ch.execute('AT+CPIN="1234"')
      t.receive('\r\nOK\r\n')
      await promise
      ch.dispose()

      const tx = records.find((r) => r.direction === 'tx')
      expect(tx?.text).toBe('AT+CPIN=[REDACTED]')
    })

    it('records a timeout outcome when no response arrives', async () => {
      const records: AuditRecord[] = []
      const { ch } = await channelWithAudit(records, 30)

      await expect(ch.execute('AT+SLOW', { timeout: 30 })).rejects.toThrow(TimeoutError)
      ch.dispose()

      expect(records.some((r) => r.outcome === 'timeout')).toBe(true)
    })
  })
})
