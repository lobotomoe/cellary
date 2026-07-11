/**
 * Internal mutable state holder for devices tracked by ModemPool.
 *
 * Shared between pool.ts (owns the map), pipeline.ts (drives readiness),
 * and wait-manager.ts (matches devices). Not part of the public API.
 */

import type { DeviceSessionSnapshot } from '../discovery/observer-types.js'
import type { Modem } from '../modem.js'
import type { DeviceReadiness } from './types.js'

/** Mutable state holder for one device in the pool. */
export interface ManagedDevice {
  vendorId: number
  name: string
  readiness: DeviceReadiness
  session: DeviceSessionSnapshot
  firstSeenAt: Date
  /** Abort controller for cancelling in-flight pipeline work. */
  abort: AbortController
  /**
   * Pipeline generation counter. Incremented on every pipeline restart.
   * Used to detect stale pipelines -- if a pipeline completes but its
   * generation doesn't match the device's current generation, the result
   * is discarded (device was detached/reattached during execution).
   */
  pipelineGeneration: number
  /** Modem event listener refs for cleanup. */
  modemListeners?:
    | {
        instance: Modem
        onDisconnect: () => void
        onClose: () => void
      }
    | undefined
  /** Retry timer for recoverable errors. */
  retryTimer?: ReturnType<typeof setTimeout> | undefined
  /** Assessment timeout timer. Fires when a device stays in critical assessing state too long. */
  assessmentTimer?: ReturnType<typeof setTimeout> | undefined
  /** How many times the pipeline has been retried after recoverable errors. */
  retryCount: number
}

// ── Timer helpers ───────────────────────────────────────────────────────────

export function clearRetryTimer(device: ManagedDevice): void {
  if (device.retryTimer !== undefined) {
    clearTimeout(device.retryTimer)
    device.retryTimer = undefined
  }
}

export function clearAssessmentTimer(device: ManagedDevice): void {
  if (device.assessmentTimer !== undefined) {
    clearTimeout(device.assessmentTimer)
    device.assessmentTimer = undefined
  }
}
