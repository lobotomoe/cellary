import type { Logger } from './logger.js'
import { sleep } from './utils.js'

const RECONNECT_INITIAL_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 60_000
const RECONNECT_MAX_ATTEMPTS = 20

export interface ReconnectConfig {
  readonly enabled: boolean
  readonly initialDelay: number
  readonly maxDelay: number
  readonly maxAttempts: number
}

export function resolveReconnectConfig(
  opt: boolean | { delay?: number; maxDelay?: number; maxAttempts?: number } | undefined,
): ReconnectConfig {
  if (opt === false) return { enabled: false, initialDelay: 0, maxDelay: 0, maxAttempts: 0 }
  if (opt === undefined || opt === true) {
    return {
      enabled: true,
      initialDelay: RECONNECT_INITIAL_DELAY_MS,
      maxDelay: RECONNECT_MAX_DELAY_MS,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
    }
  }
  return {
    enabled: true,
    initialDelay: opt.delay ?? RECONNECT_INITIAL_DELAY_MS,
    maxDelay: opt.maxDelay ?? RECONNECT_MAX_DELAY_MS,
    maxAttempts: opt.maxAttempts ?? RECONNECT_MAX_ATTEMPTS,
  }
}

/** Minimal adapter interface needed by the reconnect loop. */
export interface ReconnectableAdapter {
  readonly kind: string
  reopen?(): Promise<void>
  init?(onError?: (step: string, err: Error) => void): Promise<void>
}

export interface ReconnectCallbacks {
  /** Called once when reconnection succeeds. */
  readonly onReconnect: (adapter: ReconnectableAdapter, attempts: number) => void
  /** Called once when all attempts are exhausted (not called if aborted by close). */
  readonly onFailed: (adapter: ReconnectableAdapter, attempts: number) => void
  /** Check whether the modem has been explicitly closed. */
  readonly isClosed: () => boolean
}

/**
 * Run the reconnect loop for a single adapter.
 *
 * Implements exponential backoff with jitter. Resolves when reconnection
 * succeeds or all attempts are exhausted. Callers should use one AbortController
 * per Modem instance to cancel all in-flight loops on close().
 */
export async function startReconnectLoop(
  adapter: ReconnectableAdapter,
  config: ReconnectConfig,
  log: Logger,
  abort: AbortController,
  callbacks: ReconnectCallbacks,
): Promise<void> {
  const { initialDelay, maxDelay, maxAttempts } = config
  let attempts = 0

  while (!callbacks.isClosed() && attempts < maxAttempts) {
    // Exponential backoff with jitter
    const baseDelay = Math.min(initialDelay * 2 ** attempts, maxDelay)
    const jitter = baseDelay * (0.75 + Math.random() * 0.5)
    const effectiveDelay = Math.max(initialDelay, jitter)

    try {
      await sleep(effectiveDelay, abort.signal)
    } catch {
      // Aborted by close() -- exit immediately
      break
    }
    if (callbacks.isClosed()) break
    attempts++

    try {
      log.debug('Reconnect attempt', { adapter: adapter.kind, attempt: attempts })
      await adapter.reopen?.()
      if (callbacks.isClosed()) break
      const onError = (step: string, err: Error) =>
        log.warn(`Reconnect init step failed: ${step}`, { error: err.message })
      await adapter.init?.(onError)
      if (callbacks.isClosed()) break
      log.info('Reconnected', { adapter: adapter.kind, attempts })
      callbacks.onReconnect(adapter, attempts)
      return
    } catch (err) {
      log.debug('Reconnect attempt failed', {
        adapter: adapter.kind,
        attempt: attempts,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (!callbacks.isClosed()) {
    callbacks.onFailed(adapter, attempts)
  }
}

export interface SupervisorCallbacks {
  /** Called once when the first adapter enters the reconnect loop. */
  readonly onFirstDisconnect: () => void
  /** Called when an adapter reconnects successfully. */
  readonly onReconnect: (adapter: ReconnectableAdapter) => void
  /** Called when an adapter exhausts all reconnect attempts. */
  readonly onFailed: (adapter: ReconnectableAdapter, attempts: number) => void
  /** Called when a reconnect loop throws unexpectedly. */
  readonly onError: (adapter: ReconnectableAdapter, err: unknown) => void
  /** Whether the modem has been explicitly closed. */
  readonly isClosed: () => boolean
}

/**
 * Supervises per-adapter reconnect loops for a Modem.
 *
 * Each adapter gets its OWN AbortController. The previous single shared field
 * was clobbered whenever a second adapter began reconnecting, leaving the first
 * adapter's loop un-abortable — so on close() it kept running and re-opened the
 * transport that close() had just torn down (a leaked port).
 *
 * `shutdown()` aborts every loop AND awaits them to settle. Because a loop only
 * exits after any in-flight `reopen()` returns (reopen is not itself abortable),
 * awaiting guarantees no loop is mid-reopen once the caller proceeds to close
 * the adapters — so nothing re-opens a transport after it is closed.
 */
export class ReconnectSupervisor {
  private readonly _loops = new Map<
    ReconnectableAdapter,
    { readonly abort: AbortController; readonly done: Promise<void> }
  >()

  constructor(
    private readonly _config: ReconnectConfig,
    private readonly _log: Logger,
    private readonly _callbacks: SupervisorCallbacks,
  ) {}

  /** Whether a reconnect loop is currently running for this adapter. */
  isReconnecting(adapter: ReconnectableAdapter): boolean {
    return this._loops.has(adapter)
  }

  /** Number of adapters currently reconnecting. */
  get activeCount(): number {
    return this._loops.size
  }

  /**
   * Begin a reconnect loop for an adapter. No-op if the modem is closed or a
   * loop is already running for this adapter.
   */
  start(adapter: ReconnectableAdapter): void {
    if (this._callbacks.isClosed()) return
    if (this._loops.has(adapter)) return

    const first = this._loops.size === 0
    const abort = new AbortController()
    const done = this._run(adapter, abort)
    this._loops.set(adapter, { abort, done })
    if (first) this._callbacks.onFirstDisconnect()
  }

  /** Abort every reconnect loop and wait for them all to settle. */
  async shutdown(): Promise<void> {
    const inflight = [...this._loops.values()]
    for (const { abort } of inflight) abort.abort()
    await Promise.allSettled(inflight.map((loop) => loop.done))
    this._loops.clear()
  }

  private async _run(adapter: ReconnectableAdapter, abort: AbortController): Promise<void> {
    try {
      await startReconnectLoop(adapter, this._config, this._log, abort, {
        onReconnect: () => this._callbacks.onReconnect(adapter),
        onFailed: (_a, attempts) => this._callbacks.onFailed(adapter, attempts),
        isClosed: () => this._callbacks.isClosed(),
      })
    } catch (err) {
      this._callbacks.onError(adapter, err)
    } finally {
      this._loops.delete(adapter)
    }
  }
}
