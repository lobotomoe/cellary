/**
 * Exclusive device leases, keyed by deviceId and owned by a clientId.
 *
 * The daemon is the multi-client arbiter for physical modems. A lease gives one
 * client exclusive use of a device: once claimed, other clients' operations on
 * that device are rejected until the holder releases it or disconnects. This
 * prevents two clients from interleaving commands on the same modem (concurrent
 * SMS sends, USSD sessions, calls) -- a correctness hazard, not just a nuisance.
 *
 * Pure bookkeeping with no device or IO knowledge, so it is trivially testable
 * and has a single responsibility. DeviceManager composes it and enforces it at
 * the one choke point every service call funnels through.
 *
 * Leases are held until explicitly released or the owning client disconnects
 * (the daemon wires disconnect to releaseAllForClient). An optional ttlMs bounds
 * a lease with lazy expiry, so a wedged client that keeps its socket open but
 * stops responding cannot hold a device forever.
 */

/** Thrown when a client operates a device leased by another client. */
export class DeviceLeasedError extends Error {
  override readonly name = 'DeviceLeasedError'
  /** The clientId currently holding the lease. */
  readonly heldBy: string

  constructor(deviceId: string, heldBy: string) {
    super(`Device ${deviceId} is in use by another client`)
    this.heldBy = heldBy
  }
}

interface Lease {
  readonly clientId: string
  /** Epoch ms after which the lease auto-expires; undefined means no expiry. */
  readonly expiresAt: number | undefined
}

/** Result of a successful claim. */
export interface LeaseInfo {
  readonly deviceId: string
  /** When the lease auto-expires, or undefined if it is held until released. */
  readonly expiresAt: number | undefined
}

export class LeaseRegistry {
  private readonly _leases = new Map<string, Lease>()
  private readonly _now: () => number

  /** `now` is injectable so TTL expiry can be tested with a controllable clock. */
  constructor(now: () => number = Date.now) {
    this._now = now
  }

  /**
   * Claim exclusive use of a device for a client. Idempotent for the current
   * holder (refreshes the TTL). Throws DeviceLeasedError if another client holds
   * a live lease.
   */
  claim(deviceId: string, clientId: string, ttlMs?: number): LeaseInfo {
    const existing = this._live(deviceId)
    if (existing !== undefined && existing.clientId !== clientId) {
      throw new DeviceLeasedError(deviceId, existing.clientId)
    }
    const expiresAt = ttlMs !== undefined ? this._now() + ttlMs : undefined
    this._leases.set(deviceId, { clientId, expiresAt })
    return { deviceId, expiresAt }
  }

  /**
   * Release a device held by this client. No-op when the device is unheld or
   * already expired. Throws if it is held by a different client (a caller bug).
   */
  release(deviceId: string, clientId: string): void {
    const existing = this._live(deviceId)
    if (existing === undefined) return
    if (existing.clientId !== clientId) {
      throw new DeviceLeasedError(deviceId, existing.clientId)
    }
    this._leases.delete(deviceId)
  }

  /** Drop every lease held by a client. Wired to client disconnect. */
  releaseAllForClient(clientId: string): void {
    for (const [deviceId, lease] of this._leases) {
      if (lease.clientId === clientId) this._leases.delete(deviceId)
    }
  }

  /**
   * Throw DeviceLeasedError if the device is leased by a client other than this
   * one. Passes when the device is free or held by this client.
   */
  assertHolder(deviceId: string, clientId: string): void {
    const existing = this._live(deviceId)
    if (existing !== undefined && existing.clientId !== clientId) {
      throw new DeviceLeasedError(deviceId, existing.clientId)
    }
  }

  /** Current live holder of a device, or undefined when free/expired. */
  holder(deviceId: string): string | undefined {
    return this._live(deviceId)?.clientId
  }

  /** Look up a lease, treating an expired one as absent (lazy expiry). */
  private _live(deviceId: string): Lease | undefined {
    const lease = this._leases.get(deviceId)
    if (lease === undefined) return undefined
    if (lease.expiresAt !== undefined && lease.expiresAt <= this._now()) {
      this._leases.delete(deviceId)
      return undefined
    }
    return lease
  }
}
