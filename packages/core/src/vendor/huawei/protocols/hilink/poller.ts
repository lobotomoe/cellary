import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Network } from '../../../../protocols/adapter.js'
import type { RegistrationInfo } from '../../../../types.js'

const REGISTRATION_POLL_MS = 15_000

type EmitFn = (event: string, ...args: unknown[]) => boolean

/**
 * Background poller for the Huawei HiLink HTTP API.
 *
 * HiLink has no push or subscription model — the device's own web UI polls
 * for state changes. This poller does the same and emits domain events when
 * state changes so Modem consumers get the same reactive experience as AT URCs.
 *
 * Currently tracks:
 * - network:registration — emitted when registration status changes
 */
export class HiLinkPoller {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private lastRegistration: RegistrationInfo | undefined
  private readonly _log: Logger

  constructor(
    private readonly network: Network,
    private readonly emit: EmitFn,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  start(): void {
    if (this.timer !== undefined) return
    this.stopped = false

    this.pollRegistration().catch(() => {})
    this.timer = setInterval(() => {
      this.pollRegistration().catch(() => {})
    }, REGISTRATION_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private async pollRegistration(): Promise<void> {
    if (this.stopped) return
    try {
      const reg = await this.network.registration()
      // Don't emit after stop — an in-flight poll may complete after stop()
      if (this.stopped) return
      const prev = this.lastRegistration
      this.lastRegistration = reg

      // Skip the first observation — just record baseline, no event
      if (prev !== undefined && prev.status !== reg.status) {
        this.emit('network:registration', reg)
      }
    } catch (err: unknown) {
      this._log.debug('Registration poll failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
