import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { noopLogger } from '../src/logger.js'
import {
  type ReconnectConfig,
  ReconnectSupervisor,
  type SupervisorCallbacks,
} from '../src/reconnector.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIG: ReconnectConfig = {
  enabled: true,
  initialDelay: 1,
  maxDelay: 1,
  maxAttempts: 50,
}

function fakeAdapter(kind: string) {
  return {
    kind,
    reopen: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
  }
}

function callbacks(overrides: { isClosed?: () => boolean } = {}): SupervisorCallbacks & {
  onFirstDisconnect: ReturnType<typeof vi.fn>
  onReconnect: ReturnType<typeof vi.fn>
  onFailed: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return {
    onFirstDisconnect: vi.fn(),
    onReconnect: vi.fn(),
    onFailed: vi.fn(),
    onError: vi.fn(),
    isClosed: () => false,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReconnectSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks one loop per adapter and signals disconnect only for the first', () => {
    const cb = callbacks()
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)
    const at = fakeAdapter('at')
    const http = fakeAdapter('http')

    sup.start(at)
    sup.start(http)

    expect(sup.activeCount).toBe(2)
    expect(sup.isReconnecting(at)).toBe(true)
    expect(sup.isReconnecting(http)).toBe(true)
    expect(cb.onFirstDisconnect).toHaveBeenCalledTimes(1)
  })

  it('does not start a second loop for an adapter already reconnecting', () => {
    const cb = callbacks()
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)
    const at = fakeAdapter('at')

    sup.start(at)
    sup.start(at)

    expect(sup.activeCount).toBe(1)
  })

  it('does not start once closed', () => {
    const cb = callbacks({ isClosed: () => true })
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)

    sup.start(fakeAdapter('at'))

    expect(sup.activeCount).toBe(0)
    expect(cb.onFirstDisconnect).not.toHaveBeenCalled()
  })

  it('aborts EVERY loop on shutdown — the second adapter must not survive (MDM-C2)', async () => {
    // Both transports are down (reopen rejects) so both loops keep retrying and
    // stay alive until shutdown. The old single-abort design lost the first
    // adapter's controller when the second started, leaving it running.
    let closed = false
    const cb = callbacks({ isClosed: () => closed })
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)
    const at = fakeAdapter('at')
    const http = fakeAdapter('http')
    at.reopen.mockRejectedValue(new Error('down'))
    http.reopen.mockRejectedValue(new Error('down'))

    sup.start(at)
    sup.start(http)
    await vi.advanceTimersByTimeAsync(20) // let a few retry cycles run

    closed = true
    await sup.shutdown()
    expect(sup.activeCount).toBe(0)

    const atCalls = at.reopen.mock.calls.length
    const httpCalls = http.reopen.mock.calls.length
    // No loop may attempt another reopen after shutdown.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(at.reopen).toHaveBeenCalledTimes(atCalls)
    expect(http.reopen).toHaveBeenCalledTimes(httpCalls)
  })

  it('shutdown waits for an in-flight reopen and never completes the reconnect (MDM-C1)', async () => {
    let releaseReopen: (() => void) | undefined
    const reopenGate = new Promise<void>((resolve) => {
      releaseReopen = resolve
    })
    let closed = false
    const cb = callbacks({ isClosed: () => closed })
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)
    const at = {
      kind: 'at',
      reopen: vi.fn(() => reopenGate),
      init: vi.fn(async () => {}),
    }

    sup.start(at)
    await vi.advanceTimersByTimeAsync(5) // loop enters reopen() and blocks on the gate
    expect(at.reopen).toHaveBeenCalledOnce()

    // Close while reopen is in flight: shutdown must NOT resolve until reopen returns.
    closed = true
    let shutdownDone = false
    const shutdownP = sup.shutdown().then(() => {
      shutdownDone = true
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(shutdownDone).toBe(false)
    expect(at.init).not.toHaveBeenCalled()

    // Release reopen: the loop sees isClosed() after reopen returns and breaks
    // before init — the reconnect never completes, so nothing re-opens post-close.
    releaseReopen?.()
    await shutdownP

    expect(shutdownDone).toBe(true)
    expect(at.init).not.toHaveBeenCalled()
    expect(cb.onReconnect).not.toHaveBeenCalled()
  })

  it('reports a successful reconnect and clears the loop', async () => {
    const cb = callbacks()
    const sup = new ReconnectSupervisor(CONFIG, noopLogger, cb)
    const at = fakeAdapter('at')

    sup.start(at)
    await vi.advanceTimersByTimeAsync(20)

    expect(cb.onReconnect).toHaveBeenCalledTimes(1)
    expect(sup.activeCount).toBe(0)
    expect(sup.isReconnecting(at)).toBe(false)
  })
})
