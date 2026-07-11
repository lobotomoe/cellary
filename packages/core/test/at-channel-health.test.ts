import { describe, expect, it, vi } from 'vitest'

import { ChannelDisposedError, ChannelUnresponsiveError, TimeoutError } from '../src/errors.js'
import { ATChannel } from '../src/protocols/at/channel/at-channel.js'
import { MockTransport } from '../src/transport/mock.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAST_TIMEOUT = 50

async function createChannel(options?: { threshold?: number }) {
  const transport = new MockTransport()
  await transport.open()

  const channel = new ATChannel(transport, {
    defaultTimeout: FAST_TIMEOUT,
    consecutiveTimeoutThreshold: options?.threshold ?? 3,
  })

  return { channel, transport }
}

/**
 * Send a command that will timeout (no response from transport).
 * Catches the expected TimeoutError so it does not leak as unhandled.
 */
async function sendTimeoutCommand(channel: ATChannel, cmd = 'AT'): Promise<void> {
  await expect(channel.execute(cmd)).rejects.toThrow(TimeoutError)
}

/**
 * Send a command that will get an OK response.
 * Transport must have autoRespond configured for this command.
 */
async function sendOkCommand(
  channel: ATChannel,
  transport: MockTransport,
  cmd = 'AT',
): Promise<void> {
  transport.autoRespond({ [`${cmd}\r`]: '\r\nOK\r\n' })
  await channel.execute(cmd)
}

/**
 * Send a command that will get an ERROR response.
 * Transport must have autoRespond configured for this command.
 */
async function sendErrorCommand(
  channel: ATChannel,
  transport: MockTransport,
  cmd = 'AT+ERR',
): Promise<void> {
  transport.autoRespond({ [`${cmd}\r`]: '\r\nERROR\r\n' })
  await expect(channel.execute(cmd)).rejects.toThrow()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ATChannel health monitoring', () => {
  describe('consecutive timeout detection', () => {
    it('fires onUnresponsive callback after 3 consecutive timeouts', async () => {
      const { channel } = await createChannel()
      const onUnresponsive = vi.fn()
      channel.setOnUnresponsive(onUnresponsive)

      await sendTimeoutCommand(channel, 'CMD1')
      expect(onUnresponsive).not.toHaveBeenCalled()

      await sendTimeoutCommand(channel, 'CMD2')
      expect(onUnresponsive).not.toHaveBeenCalled()

      await sendTimeoutCommand(channel, 'CMD3')
      expect(onUnresponsive).toHaveBeenCalledOnce()
    })

    it('successful response does NOT reset counter -- catches alternating failure pattern', async () => {
      const { channel, transport } = await createChannel()
      const onUnresponsive = vi.fn()
      channel.setOnUnresponsive(onUnresponsive)

      // 2 timeouts
      await sendTimeoutCommand(channel, 'CMD1')
      await sendTimeoutCommand(channel, 'CMD2')

      // Success does NOT reset -- counter stays at 2
      await sendOkCommand(channel, transport, 'AT')

      // 1 more timeout reaches threshold 3
      await sendTimeoutCommand(channel, 'CMD3')

      expect(onUnresponsive).toHaveBeenCalledOnce()
    })

    it('ERROR response does NOT reset counter', async () => {
      const { channel, transport } = await createChannel()
      const onUnresponsive = vi.fn()
      channel.setOnUnresponsive(onUnresponsive)

      // 2 timeouts
      await sendTimeoutCommand(channel, 'CMD1')
      await sendTimeoutCommand(channel, 'CMD2')

      // ERROR does NOT reset -- counter stays at 2
      await sendErrorCommand(channel, transport, 'AT+ERR')

      // 1 more timeout reaches threshold 3
      await sendTimeoutCommand(channel, 'CMD3')

      expect(onUnresponsive).toHaveBeenCalledOnce()
    })

    it('counter resets when callback fires -- fires twice at 6 consecutive timeouts', async () => {
      const { channel } = await createChannel()
      const onUnresponsive = vi.fn()
      channel.setOnUnresponsive(onUnresponsive)

      // First 3 timeouts: callback fires, counter resets to 0
      await sendTimeoutCommand(channel, 'CMD1')
      await sendTimeoutCommand(channel, 'CMD2')
      await sendTimeoutCommand(channel, 'CMD3')
      expect(onUnresponsive).toHaveBeenCalledTimes(1)

      // Next 3 timeouts: callback fires again
      await sendTimeoutCommand(channel, 'CMD4')
      await sendTimeoutCommand(channel, 'CMD5')
      await sendTimeoutCommand(channel, 'CMD6')
      expect(onUnresponsive).toHaveBeenCalledTimes(2)
    })
  })

  describe('reset()', () => {
    it('rejects pending commands and accepts new ones', async () => {
      const { channel, transport } = await createChannel()

      // Queue a command that will never get a response
      const pendingPromise = channel.execute('AT+SLOW')

      // Let the write go through before resetting
      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+SLOW\r')
      })

      // Reset: pending command should be rejected
      channel.reset()
      await expect(pendingPromise).rejects.toThrow(ChannelDisposedError)

      // Channel should accept new commands after reset
      await sendOkCommand(channel, transport, 'AT')
    })

    it('clears unresponsive flag -- execute() works after reset', async () => {
      const { channel, transport } = await createChannel()

      // Mark unresponsive via the public API
      channel.markUnresponsive()

      // Verify that execute() rejects immediately
      await expect(channel.execute('AT')).rejects.toThrow(ChannelUnresponsiveError)

      // Reset clears the unresponsive flag
      channel.reset()

      // Channel should work again
      await sendOkCommand(channel, transport, 'AT')
    })
  })

  describe('resetConsecutiveTimeouts()', () => {
    it('resets counter mid-way -- prevents callback from firing', async () => {
      const { channel } = await createChannel()
      const onUnresponsive = vi.fn()
      channel.setOnUnresponsive(onUnresponsive)

      // 2 timeouts
      await sendTimeoutCommand(channel, 'CMD1')
      await sendTimeoutCommand(channel, 'CMD2')

      // Manually reset the counter (simulates what init() does)
      channel.resetConsecutiveTimeouts()

      // 2 more timeouts -- counter was reset, now at 2 (not 4)
      await sendTimeoutCommand(channel, 'CMD3')
      await sendTimeoutCommand(channel, 'CMD4')

      expect(onUnresponsive).not.toHaveBeenCalled()
    })
  })
})
