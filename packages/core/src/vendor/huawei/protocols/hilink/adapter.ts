import { EventEmitter } from 'node:events'
import { type AuditSink, noopAuditSink } from '../../../../audit.js'
import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type {
  Data,
  Device,
  Network,
  ProtocolAdapter,
  ServiceCapability,
  ServiceName,
  Sim,
  Traffic,
  Ussd,
} from '../../../../protocols/adapter.js'
import type { RegistrationInfo, SmsCount } from '../../../../types.js'
import { HiLinkHttpClient } from './client.js'
import { HiLinkData } from './data.js'
import { HiLinkDevice } from './device.js'
import {
  fetchHiLinkSession,
  HILINK_ERR_ACCOUNT_LOCKED,
  hilinkErrorMessage,
  loginHiLink,
} from './index.js'
import { HiLinkNetwork } from './network.js'
import { HiLinkPoller } from './poller.js'
import { HiLinkSim } from './sim.js'
import { HiLinkSmsCounter } from './sms-count.js'
import { HiLinkTraffic } from './traffic.js'
import type { HiLinkCredentials } from './types.js'
import { HiLinkUssd } from './ussd.js'

// ── Typed event declarations ──────────────────────────────────────────────────

export declare interface HiLinkAdapter {
  on(event: 'network:registration', listener: (info: RegistrationInfo) => void): this
  on(event: string, listener: (...args: unknown[]) => void): this
}

/**
 * Huawei HiLink HTTP API protocol adapter.
 *
 * Implements network, device, SIM, and USSD services via the HiLink HTTP API.
 * Provides richer signal data than AT+CSQ (RSRP, RSRQ, SINR, band) and
 * chip temperature from the undocumented /dev_info.data endpoint.
 *
 * Extends EventEmitter and runs a background poller that periodically checks
 * network state — mirroring how the HiLink web UI operates. Emits domain events
 * (e.g. 'network:registration') on state changes so Modem consumers get the same
 * reactive experience regardless of the underlying protocol.
 *
 * Authentication is centralized here: device, SIM, and USSD services all share
 * the same authenticated session via getAuthCookie(). This prevents parallel
 * login races that would lock the account.
 *
 * Pass credentials when the device has a password set. On devices with
 * hilink_login=0 (no password), credentials can be omitted — the firmware
 * authenticates the session automatically.
 */
export class HiLinkAdapter extends EventEmitter implements ProtocolAdapter {
  readonly kind = 'hilink' as const
  readonly network: Network
  readonly device: Device
  readonly sim: Sim
  readonly traffic: Traffic
  readonly data: Data
  readonly ussd: Ussd

  private readonly _smsCounter: HiLinkSmsCounter
  private readonly poller: HiLinkPoller
  private readonly credentials: HiLinkCredentials | undefined
  private readonly _log: Logger
  private readonly _audit: AuditSink
  private _authPromise: Promise<string> | undefined
  private _authTimestamp = 0

  constructor(
    readonly baseUrl: string,
    credentials?: HiLinkCredentials | undefined,
    logger?: Logger | undefined,
    auditSink?: AuditSink | undefined,
  ) {
    super()
    this.credentials = credentials
    this._log = logger ?? noopLogger
    this._audit = auditSink ?? noopAuditSink

    const client = new HiLinkHttpClient(baseUrl, undefined, this._audit)
    const getAuthCookie = () => this.getAuthCookie()
    this.network = new HiLinkNetwork(client, getAuthCookie, this._log.child({ service: 'network' }))
    this.device = new HiLinkDevice(client, getAuthCookie, this._log.child({ service: 'device' }))
    this.sim = new HiLinkSim(client, getAuthCookie, this._log.child({ service: 'sim' }))
    this._smsCounter = new HiLinkSmsCounter(client, this._log.child({ service: 'sms' }))
    this.traffic = new HiLinkTraffic(client, this._log.child({ service: 'traffic' }))
    this.data = new HiLinkData(client, this._log.child({ service: 'data' }))
    this.ussd = new HiLinkUssd(client, credentials, this._log.child({ service: 'ussd' }))
    this.poller = new HiLinkPoller(
      this.network,
      this.emit.bind(this),
      this._log.child({ service: 'poller' }),
    )
  }

  start(): void {
    this.poller.start()
  }

  stop(): void {
    this.poller.stop()
  }

  /** Tear down the adapter. Stops the poller if still running. */
  async close(): Promise<void> {
    this.poller.stop()
  }

  smsCount(): Promise<SmsCount> {
    return this._smsCounter.count()
  }

  serviceCapabilities(): Partial<Record<ServiceName, ServiceCapability>> {
    // AT now handles all services including traffic (AT^DSFLOWQRY) and
    // signal (AT^HCSQ). HiLink has no priority advantage over AT for any service.
    // It remains available as a fallback via SIM chain if AT fails.
    return {}
  }

  /**
   * Get an authenticated session cookie. Returns a cached promise so parallel
   * callers (device.info + sim.info) share one login instead of racing.
   * Re-authenticates after TTL expires (HiLink sessions are short-lived).
   */
  private getAuthCookie(): Promise<string> {
    const AUTH_TTL_MS = 4 * 60 * 1000 // 4 minutes (HiLink sessions expire in ~5 min)
    const expired = Date.now() - this._authTimestamp > AUTH_TTL_MS
    if (this._authPromise === undefined || expired) {
      this._authTimestamp = Date.now()
      this._authPromise = this.authenticate().catch((err: unknown) => {
        // Reset cache on failure so next call retries
        this._authPromise = undefined
        throw err
      })
    }
    return this._authPromise
  }

  private async authenticate(): Promise<string> {
    const session = await fetchHiLinkSession(this.baseUrl)

    // No credentials — use session cookie only (unauthenticated).
    // Works for all monitoring endpoints (signal, registration, status).
    // Auth-required endpoints (device info, SIM) will fail with clear errors.
    // On passwordless devices (hilink_login=0), the firmware grants full access
    // to the session cookie automatically.
    if (this.credentials === undefined) {
      this._log.info('No credentials — using unauthenticated session cookie')
      return session.sessionId
    }

    this._log.info('Authenticating', { baseUrl: this.baseUrl })
    const { errorCode, newSessionId } = await loginHiLink(
      this.baseUrl,
      session,
      this.credentials,
      this._audit,
    )

    if (errorCode === undefined) {
      this._log.info('Authenticated', { hasNewSession: newSessionId !== undefined })
      return newSessionId ?? session.sessionId
    }

    if (errorCode === HILINK_ERR_ACCOUNT_LOCKED) {
      this._log.error('Account locked', { errorCode })
      throw new Error(
        'HiLink account locked — too many failed login attempts. ' +
          'Unplug and replug the device to reset.',
      )
    }

    this._log.error('Login failed', { errorCode, message: hilinkErrorMessage(errorCode) })
    throw new Error(`HiLink login failed: ${hilinkErrorMessage(errorCode)}`)
  }
}
