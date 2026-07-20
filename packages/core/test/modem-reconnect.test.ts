import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Modem } from '../src/modem.js'
import { MockTransport } from '../src/transport/mock.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Open a Modem with MockTransport and an empty profile (no init commands) */
async function openMock(reconnect?: boolean | { delay?: number; maxAttempts?: number }) {
  const transport = new MockTransport()
  // Probe sends bare "AT" to verify the channel is alive
  transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })
  const modem = await Modem.open({
    path: '',
    transport,
    profile: { name: 'test', at: { initCommands: [], urcPrefixes: [] } },
    reconnect,
  })
  return { modem, transport }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Modem reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('reconnect: false', () => {
    it('emits disconnect and nothing else', async () => {
      const { modem, transport } = await openMock(false)
      const events: string[] = []
      modem.on('disconnect', () => events.push('disconnect'))
      modem.on('reconnect', () => events.push('reconnect'))

      transport.simulateDisconnect()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(events).toEqual(['disconnect'])
    })
  })

  describe('reconnect: true (default)', () => {
    it('emits disconnect immediately, then reconnect after delay', async () => {
      const { modem, transport } = await openMock(true)
      const events: string[] = []
      modem.on('disconnect', () => events.push('disconnect'))
      modem.on('reconnect', () => events.push('reconnect'))

      transport.simulateDisconnect()

      expect(events).toEqual(['disconnect'])

      // Default initial delay is 1s, with backoff + jitter the first attempt
      // fires within ~1.25s. Advance enough to cover worst case.
      await vi.advanceTimersByTimeAsync(2_000)

      expect(events).toEqual(['disconnect', 'reconnect'])
    })

    it('transport.open() is called again on reconnect', async () => {
      const { modem, transport } = await openMock(true)
      const openSpy = vi.spyOn(transport, 'open')

      transport.simulateDisconnect()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(openSpy).toHaveBeenCalledOnce()
      expect(modem.isOpen).toBe(true)
    })

    it('retries until success', async () => {
      const { modem, transport } = await openMock({ delay: 100 })
      const events: string[] = []
      modem.on('reconnect', () => events.push('reconnect'))

      // Capture the real open() before spying so the success path opens the
      // transport for real (sets isOpen), letting the post-reconnect AT probe write.
      const realOpen = transport.open.bind(transport)
      let attempt = 0
      vi.spyOn(transport, 'open').mockImplementation(async () => {
        attempt++
        if (attempt < 3) throw new Error('not yet')
        await realOpen()
      })

      transport.simulateDisconnect()

      // With exponential backoff from 100ms initial delay:
      // attempt 1 at ~100ms, attempt 2 at ~200ms, attempt 3 at ~400ms
      // Advance enough time for all three attempts with jitter headroom
      await vi.advanceTimersByTimeAsync(1_000)
      expect(events).toEqual(['reconnect'])
    })
  })

  describe('reconnect: { maxAttempts }', () => {
    it('emits reconnect:failed and error after exhausting attempts', async () => {
      const { modem, transport } = await openMock({ delay: 100, maxAttempts: 2 })
      const events: string[] = []
      modem.on('reconnect:failed', () => events.push('reconnect:failed'))
      modem.on('error', () => events.push('error'))

      vi.spyOn(transport, 'open').mockRejectedValue(new Error('unavailable'))

      transport.simulateDisconnect()
      // With backoff: attempt 1 at ~100ms, attempt 2 at ~200ms.
      // Advance enough to cover both attempts with jitter.
      await vi.advanceTimersByTimeAsync(1_000)

      expect(events).toContain('reconnect:failed')
      expect(events).toContain('error')
    })

    it('does not emit reconnect:failed if closed before attempts run out', async () => {
      const { modem, transport } = await openMock({ delay: 500, maxAttempts: 5 })
      const events: string[] = []
      modem.on('reconnect:failed', () => events.push('reconnect:failed'))

      vi.spyOn(transport, 'open').mockRejectedValue(new Error('unavailable'))

      transport.simulateDisconnect()
      await vi.advanceTimersByTimeAsync(600) // one attempt

      await modem.close() // explicit close mid-retry

      await vi.advanceTimersByTimeAsync(3_000) // remaining attempts skipped

      expect(events).toEqual([])
    })
  })

  describe('after explicit close()', () => {
    it('does not reconnect after close()', async () => {
      const { modem, transport } = await openMock(true)
      const events: string[] = []
      modem.on('disconnect', () => events.push('disconnect'))
      modem.on('reconnect', () => events.push('reconnect'))

      await modem.close()
      transport.simulateDisconnect()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(events).toEqual([])
    })
  })

  describe('AT timeout cascade', () => {
    it('3 consecutive AT timeouts trigger disconnect handler', async () => {
      const FAST_TIMEOUT = 50
      const transport = new MockTransport()
      transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })

      const modem = await Modem.open({
        path: '',
        transport,
        profile: { name: 'test', at: { initCommands: [], urcPrefixes: [] } },
        reconnect: { delay: 100 },
        defaultTimeout: FAST_TIMEOUT,
      })

      const events: string[] = []
      modem.on('disconnect', () => events.push('disconnect'))
      modem.on('reconnect', () => events.push('reconnect'))

      // Stop auto-responding so all subsequent commands timeout
      transport.clearAutoResponses()

      // Fire off 3 commands that will all timeout (don't await -- they'll resolve
      // via timer advancement). Catch expected TimeoutErrors.
      const p1 = modem.device.imei().catch(() => {})
      await vi.advanceTimersByTimeAsync(FAST_TIMEOUT + 10)

      const p2 = modem.device.imei().catch(() => {})
      await vi.advanceTimersByTimeAsync(FAST_TIMEOUT + 10)

      const p3 = modem.device.imei().catch(() => {})
      await vi.advanceTimersByTimeAsync(FAST_TIMEOUT + 10)

      // Wait for all command promises to settle
      await Promise.allSettled([p1, p2, p3])

      // The 3rd consecutive timeout should have triggered the disconnect handler,
      // which starts the reconnect loop and emits 'disconnect'.
      expect(events).toContain('disconnect')

      // Advance enough time for the reconnect attempt to fire
      transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(events).toContain('reconnect')
    })
  })
})
