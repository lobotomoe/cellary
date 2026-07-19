/**
 * Promise-based wait choreography for ModemPool.
 *
 * Manages waitForReady() and waitForDevice() promises with proper
 * timeout handling, cancellation on pool stop, and settlement guards.
 */

import type { DeviceSessionSnapshot } from '../discovery/observer-types.js'
import type { Modem } from '../modem.js'
import type { ManagedDevice } from './managed-device.js'
import type { PooledDevice } from './types.js'

const DEFAULT_WAIT_TIMEOUT_MS = 60_000

type ReadyListener = (device: PooledDevice, modem: Modem) => void
type ReadinessListener = (device: PooledDevice) => void

/** Callbacks WaitManager uses to interact with the pool. */
export interface WaitManagerDeps {
  /** Subscribe to 'modem:ready' pool event. */
  onReady(listener: ReadyListener): void
  /** Unsubscribe from 'modem:ready'. */
  offReady(listener: ReadyListener): void
  /** Subscribe to 'device:readiness' pool event. */
  onReadiness(listener: ReadinessListener): void
  /** Unsubscribe from 'device:readiness'. */
  offReadiness(listener: ReadinessListener): void
  /** Get the first ready modem, if any. */
  firstReady(): Modem | undefined
  /** Look up a ManagedDevice by its session key. */
  getDevice(session: DeviceSessionSnapshot): ManagedDevice | undefined
  /** Iterate all managed devices. */
  allDevices(): Iterable<ManagedDevice>
}

/**
 * Manages wait promises for ModemPool.
 *
 * Tracks pending waiters so the pool can cancel them on stop().
 * Each wait method handles its own timeout, cleanup, and settlement guard.
 */
export class WaitManager {
  private readonly _deps: WaitManagerDeps
  private readonly _pending = new Set<() => void>()

  constructor(deps: WaitManagerDeps) {
    this._deps = deps
  }

  /** Cancel all pending wait promises. Called by pool on stop(). */
  cancelAll(): void {
    for (const cancel of this._pending) {
      cancel()
    }
    this._pending.clear()
  }

  /**
   * Wait for at least one modem to reach 'ready' or 'degraded' stage.
   * Resolves with the first modem that becomes ready.
   * Rejects after timeoutMs (default: 60s).
   */
  waitForReady(timeoutMs?: number): Promise<Modem> {
    // Check if already ready
    const existing = this._deps.firstReady()
    if (existing !== undefined) return Promise.resolve(existing)

    const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS

    return new Promise<Modem>((resolve, reject) => {
      let settled = false

      const onReady = (_device: PooledDevice, modem: Modem) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._deps.offReady(onReady)
        this._pending.delete(cancel)
        resolve(modem)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this._deps.offReady(onReady)
        this._pending.delete(cancel)
        const stages = [...this._deps.allDevices()].map((d) => `${d.name}: ${d.readiness.stage}`)
        reject(
          new Error(
            `No modem became ready within ${timeout}ms. ` +
              `Devices: ${stages.length > 0 ? stages.join(', ') : 'none detected'}`,
          ),
        )
      }, timeout)

      const cancel = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._deps.offReady(onReady)
        reject(new Error('Pool stopped while waiting for device'))
      }

      this._pending.add(cancel)
      this._deps.onReady(onReady)
    })
  }

  /**
   * Wait for a specific device to reach 'ready' or 'degraded'.
   * Matched by vendorId (number) or name substring (string, case-insensitive).
   */
  waitForDevice(filter: string | number, timeoutMs?: number): Promise<Modem> {
    const matcher =
      typeof filter === 'number'
        ? (d: ManagedDevice) => d.vendorId === filter
        : (d: ManagedDevice) => d.name.toLowerCase().includes(filter.toLowerCase())

    // Check if already ready
    for (const device of this._deps.allDevices()) {
      if (!matcher(device)) continue
      const { readiness } = device
      if (readiness.stage === 'ready' || readiness.stage === 'degraded') {
        return Promise.resolve(readiness.modem)
      }
    }

    const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS

    return new Promise<Modem>((resolve, reject) => {
      let settled = false

      const onReadiness = (pooled: PooledDevice) => {
        if (settled) return
        const { readiness: r } = pooled
        if (r.stage !== 'ready' && r.stage !== 'degraded') return
        const device = this._deps.getDevice(pooled.session)
        if (device === undefined || !matcher(device)) return

        settled = true
        clearTimeout(timer)
        this._deps.offReadiness(onReadiness)
        this._pending.delete(cancel)
        resolve(r.modem)
      }

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this._deps.offReadiness(onReadiness)
        this._pending.delete(cancel)
        reject(new Error(`Device matching '${filter}' did not become ready within ${timeout}ms`))
      }, timeout)

      const cancel = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this._deps.offReadiness(onReadiness)
        reject(new Error('Pool stopped while waiting for device'))
      }

      this._pending.add(cancel)
      this._deps.onReadiness(onReadiness)
    })
  }
}
