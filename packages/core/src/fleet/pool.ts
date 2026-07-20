/**
 * Fleet-level modem lifecycle management.
 *
 * ModemPool sits on top of DeviceObserver and automatically drives each
 * detected modem through the readiness pipeline:
 *   detected -> assessing -> preparing -> connecting -> checking -> ready
 *
 * The pool is the single entry point for fleet management -- CLI reads from it,
 * commands wait on it.
 *
 * Pipeline orchestration lives in pipeline.ts, wait choreography in wait-manager.ts.
 */

import { EventEmitter } from 'node:events'

import { DeviceObserver } from '../discovery/observer.js'
import type { DeviceSessionSnapshot, DeviceStateAnalysis } from '../discovery/observer-types.js'
import { type Logger, noopLogger } from '../logger.js'
import { DEFAULT_RESOLVERS, DEFAULT_VENDORS, type Modem } from '../modem.js'
import type { VendorPlugin } from '../protocols/adapter.js'

import {
  clearAssessmentTimer,
  clearRetryTimer,
  evaluateAssessment,
  type ManagedDevice,
  type PipelineContext,
  startAssessment,
} from './pipeline.js'
import type { DeviceReadiness, PoolEventMap, PooledDevice, PoolOptions } from './types.js'
import { WaitManager } from './wait-manager.js'

// ── Typed EventEmitter declaration ──────────────────────────────────────────

export declare interface ModemPool {
  on<K extends keyof PoolEventMap>(event: K, listener: (...args: PoolEventMap[K]) => void): this
  off<K extends keyof PoolEventMap>(event: K, listener: (...args: PoolEventMap[K]) => void): this
  emit<K extends keyof PoolEventMap>(event: K, ...args: PoolEventMap[K]): boolean
  once<K extends keyof PoolEventMap>(event: K, listener: (...args: PoolEventMap[K]) => void): this
}

// ── ModemPool ───────────────────────────────────────────────────────────────

export class ModemPool extends EventEmitter {
  private readonly _observer: DeviceObserver
  private readonly _devices = new Map<string, ManagedDevice>()
  private readonly _vendors: ReadonlyMap<string, VendorPlugin>
  private readonly _autoProvision: boolean
  private readonly _log: Logger
  private readonly _waitManager: WaitManager
  private readonly _pipelineCtx: PipelineContext
  private _started = false

  constructor(options?: PoolOptions) {
    super()

    this._vendors = options?.vendors ?? DEFAULT_VENDORS
    this._autoProvision = options?.autoProvision !== false
    this._log = options?.logger ?? noopLogger

    this._observer = new DeviceObserver({
      resolvers: options?.resolvers ?? DEFAULT_RESOLVERS,
      goneTimeoutMs: options?.goneTimeoutMs,
      modemDatabase: options?.modemDatabase,
    })

    this._pipelineCtx = {
      vendors: this._vendors,
      log: this._log,
      createAuditSink: options?.createAuditSink,
      setReadiness: (device, readiness) => this._setReadiness(device, readiness),
      wireModem: (device, instance) => this._wireModem(device, instance),
      emitReady: (pooled, modem) => this.emit('modem:ready', pooled, modem),
      toPooled: (device) => toPooledDevice(device),
      clearAssessmentTimer: (device) => clearAssessmentTimer(device),
      pauseUsbWatcher: () => this._observer.pauseWatcher(),
      resumeUsbWatcher: () => this._observer.resumeWatcher(),
    }

    this._waitManager = new WaitManager({
      onReady: (listener) => this.on('modem:ready', listener),
      offReady: (listener) => this.off('modem:ready', listener),
      onReadiness: (listener) => this.on('device:readiness', listener),
      offReadiness: (listener) => this.off('device:readiness', listener),
      firstReady: () => this.firstReady,
      getDevice: (session) => this._devices.get(deviceKey(session)),
      allDevices: () => this._devices.values(),
    })

    this._wireObserverEvents()
  }

  /** Start watching USB bus and managing devices. */
  async start(): Promise<void> {
    if (this._started) return
    this._started = true
    this._log.info('ModemPool started')
    await this._observer.start()
  }

  /** Stop watching, close all managed modems, clean up. */
  async stop(): Promise<void> {
    if (!this._started) return
    this._started = false
    this._log.info('ModemPool stopping')

    // Cancel all pending waitForReady/waitForDevice promises
    this._waitManager.cancelAll()

    // Abort all in-flight pipelines and cancel timers
    for (const device of this._devices.values()) {
      device.abort.abort()
      clearRetryTimer(device)
      clearAssessmentTimer(device)
    }

    // Close all ready/degraded modems
    const closePromises: Promise<void>[] = []
    for (const device of this._devices.values()) {
      const { readiness } = device
      if (readiness.stage === 'ready' || readiness.stage === 'degraded') {
        closePromises.push(readiness.modem.close())
      }
    }
    await Promise.allSettled(closePromises)

    this._devices.clear()
    this._observer.dispose()
  }

  /** All currently tracked devices. */
  get devices(): readonly PooledDevice[] {
    return [...this._devices.values()].map((d) => toPooledDevice(d))
  }

  /** Get devices in a specific stage. */
  byStage(stage: DeviceReadiness['stage']): readonly PooledDevice[] {
    const result: PooledDevice[] = []
    for (const d of this._devices.values()) {
      if (d.readiness.stage === stage) {
        result.push(toPooledDevice(d))
      }
    }
    return result
  }

  /** Get first ready modem, or undefined. */
  get firstReady(): Modem | undefined {
    for (const device of this._devices.values()) {
      const { readiness } = device
      if (readiness.stage === 'ready' || readiness.stage === 'degraded') {
        return readiness.modem
      }
    }
    return undefined
  }

  /**
   * Wait for at least one modem to reach 'ready' or 'degraded' stage.
   * Resolves with the first modem that becomes ready.
   * Rejects after timeoutMs (default: 60s).
   */
  waitForReady(timeoutMs?: number): Promise<Modem> {
    return this._waitManager.waitForReady(timeoutMs)
  }

  /**
   * Wait for a specific device to reach 'ready' or 'degraded'.
   * Matched by vendorId (number) or name substring (string, case-insensitive).
   */
  waitForDevice(filter: string | number, timeoutMs?: number): Promise<Modem> {
    return this._waitManager.waitForDevice(filter, timeoutMs)
  }

  /**
   * Wait for the device with an exact stable identity (deviceId) to reach
   * 'ready' or 'degraded'. Targets a single physical device -- required when
   * two identical modems (same vendorId/name) must be told apart.
   */
  waitForDeviceId(deviceId: string, timeoutMs?: number): Promise<Modem> {
    return this._waitManager.waitForDeviceId(deviceId, timeoutMs)
  }

  /**
   * Restart the readiness pipeline for a device.
   *
   * Used after a USB reset: the device is still physically on the bus but
   * the pool marked it offline when the modem closed. This method puts it
   * back to 'detected' and re-triggers assessment, so the pool reconnects
   * without waiting for a USB detach/reattach cycle (which doesn't happen
   * on macOS after a USB reset).
   */
  restartDevice(deviceId: string): void {
    const device = this._devices.get(deviceId)
    if (device === undefined) {
      throw new Error(`Device ${deviceId} not found in pool`)
    }

    this._log.info('Restarting device pipeline', {
      name: device.name,
      from: device.readiness.stage,
    })

    // Abort any in-flight work, clean up
    device.abort.abort()
    device.abort = new AbortController()
    device.pipelineGeneration++
    clearRetryTimer(device)
    this._unwireModem(device)
    device.retryCount = 0

    // Reset to detected and re-trigger assessment
    this._setReadiness(device, { stage: 'detected' })

    if (this._autoProvision) {
      const snapshot = device.session
      // Neutral analysis: device is in a known-good state after reset
      const analysis: DeviceStateAnalysis = {
        state: 'modem',
        description: 'Restarted after USB reset',
        severity: 'normal',
        recommendations: [],
        expectedNextPid: undefined,
        estimatedRecoveryMs: undefined,
      }
      startAssessment(this._pipelineCtx, device, snapshot, analysis)
    }
  }

  // ── Observer event wiring ─────────────────────────────────────────────────

  private _wireObserverEvents(): void {
    this._observer.on('device:appeared', (session, analysis) => {
      this._onDeviceAppeared(session, analysis)
    })

    this._observer.on('device:attached', (session, analysis) => {
      this._onDeviceReattached(session, analysis)
    })

    this._observer.on('device:detached', (session) => {
      this._onDeviceDetached(session)
    })

    this._observer.on('device:state-changed', (session, analysis) => {
      this._onStateChanged(session, analysis)
    })

    this._observer.on('device:gone', (session) => {
      this._onDeviceGone(session)
    })
  }

  private _onDeviceAppeared(session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis): void {
    const key = deviceKey(session)

    const device: ManagedDevice = {
      vendorId: session.vendorId,
      name: session.vendorName,
      readiness: { stage: 'detected' },
      session,
      firstSeenAt: new Date(),
      abort: new AbortController(),
      pipelineGeneration: 0,
      retryCount: 0,
    }

    this._devices.set(key, device)
    this._log.info('Device appeared', { name: device.name, vendorId: hex(device.vendorId) })
    this.emit('device:added', toPooledDevice(device))

    if (this._autoProvision) {
      startAssessment(this._pipelineCtx, device, session, analysis)
    }
  }

  private _onDeviceReattached(session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis): void {
    const key = deviceKey(session)
    const device = this._devices.get(key)
    if (device === undefined) return

    device.session = session

    // If device was offline, restart the pipeline
    if (device.readiness.stage === 'offline') {
      this._log.info('Device reattached, restarting pipeline', { name: device.name })
      device.abort = new AbortController()
      device.pipelineGeneration++
      device.retryCount = 0
      this._setReadiness(device, { stage: 'detected' })

      if (this._autoProvision) {
        startAssessment(this._pipelineCtx, device, session, analysis)
      }
    }
  }

  private _onDeviceDetached(session: DeviceSessionSnapshot): void {
    const key = deviceKey(session)
    const device = this._devices.get(key)
    if (device === undefined) return

    device.session = session

    // Abort in-flight work
    device.abort.abort()
    device.abort = new AbortController()
    device.pipelineGeneration++

    // Cancel pending timers and clean up modem listeners
    clearRetryTimer(device)
    clearAssessmentTimer(device)
    this._unwireModem(device)
    device.retryCount = 0

    // Close modem if it was ready
    const { readiness } = device
    if (readiness.stage === 'ready' || readiness.stage === 'degraded') {
      readiness.modem.close().catch((err: unknown) => {
        this._log.warn('Error closing modem on detach', { name: device.name, error: err })
      })
    }

    this._setReadiness(device, { stage: 'offline' })
  }

  private _onStateChanged(session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis): void {
    const key = deviceKey(session)
    const device = this._devices.get(key)
    if (device === undefined) return

    device.session = session

    const { readiness } = device

    // If in assessing stage, re-evaluate whether to proceed
    if (readiness.stage === 'assessing') {
      evaluateAssessment(this._pipelineCtx, device, session, analysis)
      return
    }

    // Recover a device that stalled in assessment: the assessment timeout parked
    // it in a recoverable error, but before the timeout this very signal
    // (device:state-changed) would have driven it forward. Once it leaves the
    // critical state and a modem is available again, resume assessment in place
    // -- otherwise a device that recovers on the bus (without a physical replug)
    // is dead-ended despite advertising recoverable: true.
    if (
      readiness.stage === 'error' &&
      readiness.recoverable &&
      device.assessmentStalled === true &&
      analysis.severity !== 'critical' &&
      session.currentCycle?.modem !== undefined
    ) {
      this._log.info('Device left critical state, resuming assessment', { name: device.name })
      device.assessmentStalled = false
      evaluateAssessment(this._pipelineCtx, device, session, analysis)
    }
  }

  private _onDeviceGone(session: DeviceSessionSnapshot): void {
    const key = deviceKey(session)
    const device = this._devices.get(key)
    if (device === undefined) return

    this._log.info('Device gone', { name: device.name })

    // Clean up all resources
    clearRetryTimer(device)
    clearAssessmentTimer(device)
    this._unwireModem(device)
    const { readiness } = device
    if (readiness.stage === 'ready' || readiness.stage === 'degraded') {
      readiness.modem.close().catch((err: unknown) => {
        this._log.warn('Error closing modem on gone', { name: device.name, error: err })
      })
    }

    this._devices.delete(key)
    this.emit('device:removed', toPooledDevice(device))
  }

  // ── Modem lifecycle wiring ────────────────────────────────────────────────

  /** Attach modem lifecycle listeners and track them for cleanup. */
  private _wireModem(device: ManagedDevice, instance: Modem): void {
    const onDisconnect = () => {
      if (device.readiness.stage === 'ready' || device.readiness.stage === 'degraded') {
        this._log.warn('Modem transport disconnected', { name: device.name })
      }
    }

    const onClose = () => {
      // If modem closes while we think it's ready, mark offline
      if (device.readiness.stage === 'ready' || device.readiness.stage === 'degraded') {
        this._setReadiness(device, { stage: 'offline' })
      }
    }

    instance.on('disconnect', onDisconnect)
    instance.on('close', onClose)

    device.modemListeners = { instance, onDisconnect, onClose }
  }

  /** Remove modem lifecycle listeners. */
  private _unwireModem(device: ManagedDevice): void {
    const listeners = device.modemListeners
    if (listeners === undefined) return

    listeners.instance.off('disconnect', listeners.onDisconnect)
    listeners.instance.off('close', listeners.onClose)
    device.modemListeners = undefined
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _setReadiness(device: ManagedDevice, readiness: DeviceReadiness): void {
    const previous = device.readiness
    device.readiness = readiness
    this._log.debug('Readiness changed', {
      name: device.name,
      from: previous.stage,
      to: readiness.stage,
    })
    this.emit('device:readiness', toPooledDevice(device), previous)
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function deviceKey(session: DeviceSessionSnapshot): string {
  return session.deviceId
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`
}

function toPooledDevice(device: ManagedDevice): PooledDevice {
  return {
    vendorId: device.vendorId,
    name: device.name,
    readiness: device.readiness,
    session: device.session,
    firstSeenAt: device.firstSeenAt,
  }
}
