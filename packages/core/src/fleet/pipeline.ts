/**
 * Readiness pipeline orchestration.
 *
 * Drives a ManagedDevice through: assessing -> preparing -> connecting -> checking -> ready.
 * Extracted from ModemPool for single-responsibility: pool owns the device map and events,
 * pipeline owns the progression logic.
 */

import type { AuditSink } from '../audit.js'
import type { DeviceSessionSnapshot, DeviceStateAnalysis } from '../discovery/observer-types.js'
import type { DiscoveredModem } from '../discovery/usb-types.js'
import type { Logger } from '../logger.js'
import { type ConnectOptions, Modem } from '../modem.js'
import type { VendorPlugin } from '../protocols/adapter.js'

import type { ManagedDevice } from './managed-device.js'
import { clearRetryTimer } from './managed-device.js'
import type { DeviceReadiness, PooledDevice } from './types.js'

// Re-export so pool.ts can import everything from pipeline.js
export type { ManagedDevice } from './managed-device.js'
export { clearAssessmentTimer, clearRetryTimer } from './managed-device.js'

/** Callbacks the pipeline uses to communicate with the pool. */
export interface PipelineContext {
  readonly vendors: ReadonlyMap<string, VendorPlugin>
  readonly log: Logger
  /** Per-device audit sink factory. Bound to the device's deviceId at connect. */
  readonly createAuditSink?: ((deviceId: string) => AuditSink) | undefined
  /** Update device readiness and emit pool event. */
  setReadiness(device: ManagedDevice, readiness: DeviceReadiness): void
  /** Wire modem lifecycle listeners (disconnect/close). */
  wireModem(device: ManagedDevice, instance: Modem): void
  /** Emit 'modem:ready' on the pool. */
  emitReady(device: PooledDevice, modem: Modem): void
  /** Convert ManagedDevice to PooledDevice snapshot. */
  toPooled(device: ManagedDevice): PooledDevice
  /** Clear assessment timer. */
  clearAssessmentTimer(device: ManagedDevice): void
  /**
   * Pause the USB hotplug watcher.
   * On macOS, releases IOKit references so child processes can claim USB interfaces.
   */
  pauseUsbWatcher(): void
  /** Resume the USB hotplug watcher after a mode switch. */
  resumeUsbWatcher(): void
}

// ── Constants ───────────────────────────────────────────────────────────────

const ASSESSMENT_TIMEOUT_MS = 30_000
const ERROR_RETRY_DELAY_MS = 10_000
const MAX_ERROR_RETRIES = 3

// ── Pipeline stages ─────────────────────────────────────────────────────────

/**
 * Begin assessment for a device. Sets a timeout for critical states,
 * then evaluates whether to proceed immediately.
 */
export function startAssessment(
  ctx: PipelineContext,
  device: ManagedDevice,
  session: DeviceSessionSnapshot,
  analysis: DeviceStateAnalysis,
): void {
  ctx.clearAssessmentTimer(device)
  // Fresh assessment supersedes any prior stall marker.
  device.assessmentStalled = false
  ctx.setReadiness(device, { stage: 'assessing', analysis })

  // Start timeout: if the device stays in a critical assessing state too long,
  // park it in a recoverable error. It is not a dead end -- a later favourable
  // device:state-changed re-drives assessment (see ModemPool._onStateChanged),
  // and a physical replug recovers it via the offline path.
  const generation = device.pipelineGeneration
  device.assessmentTimer = setTimeout(() => {
    device.assessmentTimer = undefined
    if (device.pipelineGeneration !== generation) return
    if (device.readiness.stage !== 'assessing') return

    ctx.log.warn('Assessment timed out', { name: device.name, description: analysis.description })
    device.assessmentStalled = true
    ctx.setReadiness(device, {
      stage: 'error',
      error: new Error(`Device stuck in critical state: ${analysis.description}`),
      recoverable: true,
    })
  }, ASSESSMENT_TIMEOUT_MS)

  evaluateAssessment(ctx, device, session, analysis)
}

/**
 * Check whether assessment has resolved. Critical states stay in assessing;
 * normal/degraded states proceed to preparing.
 */
export function evaluateAssessment(
  ctx: PipelineContext,
  device: ManagedDevice,
  session: DeviceSessionSnapshot,
  analysis: DeviceStateAnalysis,
): void {
  // Critical state (boot-loop, EDL) -- stay in assessing, wait for state change
  if (analysis.severity === 'critical') {
    ctx.log.warn('Device in critical state, deferring provision', {
      name: device.name,
      state: analysis.state,
      description: analysis.description,
    })
    ctx.setReadiness(device, { stage: 'assessing', analysis })
    return
  }

  // Assessment resolved -- clear the timeout and proceed
  ctx.clearAssessmentTimer(device)

  // Normal or degraded -- proceed to preparing
  const modem = session.currentCycle?.modem
  if (modem === undefined) {
    ctx.log.warn('No modem in current cycle, cannot prepare', { name: device.name })
    return
  }

  startPreparing(ctx, device, modem)
}

/**
 * Transition to preparing and kick off the async pipeline.
 * Handles pipeline errors with retry logic.
 */
export function startPreparing(
  ctx: PipelineContext,
  device: ManagedDevice,
  modem: DiscoveredModem,
): void {
  ctx.setReadiness(device, { stage: 'preparing' })

  const signal = device.abort.signal
  const generation = device.pipelineGeneration

  runPipeline(ctx, device, modem, signal, generation).catch((err: unknown) => {
    if (signal.aborted) return // expected on detach/stop
    if (device.pipelineGeneration !== generation) return // stale pipeline

    const wrappedError = err instanceof Error ? err : new Error(String(err))
    const canRetry = device.retryCount < MAX_ERROR_RETRIES

    ctx.log.error('Pipeline failed', {
      name: device.name,
      error: wrappedError.message,
      retryCount: device.retryCount,
      willRetry: canRetry,
    })

    ctx.setReadiness(device, {
      stage: 'error',
      error: wrappedError,
      recoverable: canRetry,
    })

    if (canRetry) {
      scheduleRetry(ctx, device, modem)
    }
  })
}

/**
 * Run the full pipeline: provision -> connect -> health-check.
 * Each stage updates device readiness as it progresses.
 *
 * The generation parameter detects stale pipelines: if the device's
 * pipelineGeneration has changed (due to detach/reattach), this pipeline
 * is outdated and must not update device state.
 */
async function runPipeline(
  ctx: PipelineContext,
  device: ManagedDevice,
  modem: DiscoveredModem,
  signal: AbortSignal,
  generation: number,
): Promise<void> {
  // Stage: provisioning
  const { provision } = await import('../discovery/provisioner.js')
  const prepared = await provision(modem, {
    beforeModeSwitch: () => ctx.pauseUsbWatcher(),
    afterModeSwitch: () => ctx.resumeUsbWatcher(),
  })
  if (signal.aborted || device.pipelineGeneration !== generation) return

  // Stage: connecting (covers adapter creation, init, and health checks)
  ctx.setReadiness(device, { stage: 'connecting', prepared })

  const connectOptions: ConnectOptions = {
    vendors: ctx.vendors,
    logger: ctx.log,
    auditSink: ctx.createAuditSink?.(device.session.deviceId),
    onProgress: (event) => {
      if (signal.aborted || device.pipelineGeneration !== generation) return
      if (event.phase === 'checking') {
        ctx.setReadiness(device, { stage: 'checking' })
      }
    },
  }
  const instance = await Modem.connectFromPrepared(prepared, connectOptions)

  // Check both abort signal and generation BEFORE updating readiness.
  // A detach during connectFromPrepared means this pipeline is stale --
  // the modem must be closed without touching device state.
  if (signal.aborted || device.pipelineGeneration !== generation) {
    await instance.close()
    return
  }

  // Wire modem lifecycle events (tracked for cleanup on detach/gone)
  ctx.wireModem(device, instance)

  // Determine final stage from health check verdict.
  // autoInit is always true in pool pipeline, so report is always present.
  const report = instance.preparation
  if (report === undefined) {
    throw new Error('Bug: connectFromPrepared completed without a preparation report')
  }

  if (report.verdict === 'degraded') {
    ctx.setReadiness(device, { stage: 'degraded', modem: instance, report })
  } else {
    ctx.setReadiness(device, { stage: 'ready', modem: instance, report })
  }

  ctx.emitReady(ctx.toPooled(device), instance)
}

/**
 * Schedule a retry after a recoverable pipeline error.
 * After a delay, restarts the pipeline if the device is still in error state
 * and hasn't been detached/reattached in the meantime.
 */
function scheduleRetry(ctx: PipelineContext, device: ManagedDevice, modem: DiscoveredModem): void {
  clearRetryTimer(device)

  const generation = device.pipelineGeneration

  device.retryTimer = setTimeout(() => {
    device.retryTimer = undefined

    // Stale retry (device was detached/reattached since scheduling)
    if (device.pipelineGeneration !== generation) return
    // Only retry if still in error state
    if (device.readiness.stage !== 'error') return

    device.retryCount++
    ctx.log.info('Retrying pipeline after error', {
      name: device.name,
      attempt: device.retryCount,
      maxAttempts: MAX_ERROR_RETRIES,
    })

    startPreparing(ctx, device, modem)
  }, ERROR_RETRY_DELAY_MS)
}
