/**
 * System-level device state observer.
 *
 * Wraps the raw USB watch() events, groups them into per-device sessions,
 * tracks timing patterns, and runs vendor-pluggable resolvers to produce
 * semantic state analysis (boot-loop detection, mode-switch tracking, etc.).
 *
 * Identity: keyed by deviceId (USB bus:port path or serial port path).
 * Multiple same-vendor devices on different USB ports get separate sessions.
 */

import { EventEmitter } from 'node:events'
import { preflightDarwinModeSwitch } from './modeswitch.js'
import type {
  DeviceObserverEvents,
  DeviceObserverOptions,
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
  UsbCycle,
} from './observer-types.js'
import { scanUsb } from './scanner.js'
import type { DiscoveredModem } from './usb-types.js'
import { type ModemWatchEvent, watch } from './watcher.js'

// -- Constants ---------------------------------------------------------------

const DEFAULT_MAX_CYCLE_HISTORY = 20
const DEFAULT_GONE_TIMEOUT_MS = 300_000 // 5 minutes

// -- Typed EventEmitter declaration ------------------------------------------

export declare interface DeviceObserver {
  on<K extends keyof DeviceObserverEvents>(
    event: K,
    listener: (...args: DeviceObserverEvents[K]) => void,
  ): this
  off<K extends keyof DeviceObserverEvents>(
    event: K,
    listener: (...args: DeviceObserverEvents[K]) => void,
  ): this
  emit<K extends keyof DeviceObserverEvents>(event: K, ...args: DeviceObserverEvents[K]): boolean
  once<K extends keyof DeviceObserverEvents>(
    event: K,
    listener: (...args: DeviceObserverEvents[K]) => void,
  ): this
}

// -- DeviceSession (internal) ------------------------------------------------

/**
 * Mutable state holder for one physical device's observation history.
 * Not exported -- consumers see immutable DeviceSessionSnapshot.
 */
class DeviceSession {
  readonly id: string
  readonly vendorId: number
  vendorName: string
  serialNumber: string | undefined = undefined

  /** Completed cycles, most recent first. */
  private readonly _history: UsbCycle[] = []
  private _currentCycle: UsbCycle | undefined = undefined
  private _firstSeenAt: number

  private readonly _maxHistory: number

  constructor(id: string, vendorId: number, vendorName: string, maxHistory: number) {
    this.id = id
    this.vendorId = vendorId
    this.vendorName = vendorName
    this._maxHistory = maxHistory
    this._firstSeenAt = Date.now()
  }

  get currentCycle(): UsbCycle | undefined {
    return this._currentCycle
  }

  get state(): 'on-bus' | 'off-bus' {
    return this._currentCycle !== undefined ? 'on-bus' : 'off-bus'
  }

  recordAttach(pid: number, name: string, modem: DiscoveredModem | undefined): void {
    this._currentCycle = {
      pid,
      name,
      attachedAt: Date.now(),
      detachedAt: undefined,
      modem,
    }
  }

  recordDetach(): void {
    if (this._currentCycle === undefined) return

    const now = Date.now()
    const completed: UsbCycle = {
      ...this._currentCycle,
      detachedAt: now,
    }

    this._currentCycle = undefined

    // Prepend (most recent first), cap size
    this._history.unshift(completed)
    if (this._history.length > this._maxHistory) {
      this._history.pop()
    }
  }

  snapshot(): DeviceSessionSnapshot {
    const completedCycles = this._history
    const completedCount = completedCycles.length

    let avgOnBusDurationMs: number | undefined
    let avgOffBusDurationMs: number | undefined

    if (completedCount >= 2) {
      // Average on-bus duration
      let totalOnBus = 0
      for (const cycle of completedCycles) {
        if (cycle.detachedAt !== undefined) {
          totalOnBus += cycle.detachedAt - cycle.attachedAt
        }
      }
      avgOnBusDurationMs = Math.round(totalOnBus / completedCount)

      // Average off-bus gap (time between detach[i] and attach[i-1], where i is newer)
      // History is most-recent-first, so gap = history[i].attachedAt - history[i+1].detachedAt
      let totalGaps = 0
      let gapCount = 0
      for (let i = 0; i < completedCycles.length - 1; i++) {
        const newer = completedCycles[i]
        const older = completedCycles[i + 1]
        if (newer === undefined || older === undefined) continue
        if (older.detachedAt !== undefined) {
          totalGaps += newer.attachedAt - older.detachedAt
          gapCount++
        }
      }
      if (gapCount > 0) {
        avgOffBusDurationMs = Math.round(totalGaps / gapCount)
      }
    }

    return {
      deviceId: this.id,
      vendorId: this.vendorId,
      vendorName: this.vendorName,
      serialNumber: this.serialNumber,
      currentCycle: this._currentCycle,
      history: [...completedCycles],
      firstSeenAt: this._firstSeenAt,
      state: this.state,
      completedCycleCount: completedCount,
      avgOnBusDurationMs,
      avgOffBusDurationMs,
    }
  }
}

// -- DeviceObserver ----------------------------------------------------------

export class DeviceObserver extends EventEmitter {
  private readonly _resolvers: readonly DeviceStateResolver[]
  private readonly _maxCycleHistory: number
  private readonly _goneTimeoutMs: number

  /** Active sessions keyed by deviceId (bus:port path or serial path). */
  private readonly _sessions = new Map<string, DeviceSession>()

  /** Gone timers keyed by session key. */
  private readonly _goneTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** Previous analysis per session key (for state-changed detection). */
  private readonly _lastAnalysis = new Map<string, DeviceStateAnalysis>()

  /** Stop function from watch(). undefined if disposed. */
  private _stopWatch: (() => void) | undefined

  private readonly _modemDatabase: DeviceObserverOptions['modemDatabase']

  constructor(options: DeviceObserverOptions = {}) {
    super()
    this._resolvers = options.resolvers ?? []
    this._maxCycleHistory = options.maxCycleHistory ?? DEFAULT_MAX_CYCLE_HISTORY
    this._goneTimeoutMs = options.goneTimeoutMs ?? DEFAULT_GONE_TIMEOUT_MS
    this._modemDatabase = options.modemDatabase
  }

  /**
   * Start observing.
   *
   * On macOS, runs a pre-libusb preflight that ejects storage-mode devices
   * via `diskutil` before libusb opens any IOKit handles. Then seeds from
   * currently connected devices and subscribes to USB hotplug.
   */
  async start(): Promise<void> {
    if (this._stopWatch !== undefined) return // already started

    // macOS: eject storage-mode devices before libusb touches them
    if (this._modemDatabase !== undefined && this._modemDatabase.length > 0) {
      await preflightDarwinModeSwitch(this._modemDatabase)
    }

    // Seed from current USB bus state
    for (const modem of scanUsb()) {
      this._handleAttach(modem, true)
    }

    // Subscribe to hotplug
    this._stopWatch = watch((event: ModemWatchEvent) => {
      if (event.type === 'attached') {
        this._handleAttach(event.modem, false)
      } else {
        this._handleDetach(event.modem)
      }
    })
  }

  /** Snapshot of all active sessions. */
  get sessions(): ReadonlyMap<string, DeviceSessionSnapshot> {
    const result = new Map<string, DeviceSessionSnapshot>()
    for (const [key, session] of this._sessions) {
      result.set(key, session.snapshot())
    }
    return result
  }

  /**
   * Temporarily stop the USB hotplug watcher without clearing sessions.
   *
   * On macOS, the hotplug watcher keeps IOKit references active, which
   * blocks other processes from claiming USB interfaces. Pausing before
   * a child-process mode switch releases these IOKit resources.
   */
  pauseWatcher(): void {
    if (this._stopWatch !== undefined) {
      this._stopWatch()
      this._stopWatch = undefined
    }
  }

  /**
   * Resume the USB hotplug watcher after a pause.
   * Does NOT re-scan — only re-subscribes to attach/detach events.
   */
  resumeWatcher(): void {
    if (this._stopWatch !== undefined) return // already watching

    this._stopWatch = watch((event: ModemWatchEvent) => {
      if (event.type === 'attached') {
        this._handleAttach(event.modem, false)
      } else {
        this._handleDetach(event.modem)
      }
    })
  }

  /** Stop observing, clear all timers, remove all sessions. */
  dispose(): void {
    if (this._stopWatch !== undefined) {
      this._stopWatch()
      this._stopWatch = undefined
    }

    for (const timer of this._goneTimers.values()) {
      clearTimeout(timer)
    }
    this._goneTimers.clear()
    this._sessions.clear()
    this._lastAnalysis.clear()
    this.removeAllListeners()
  }

  // -- Internal event handling -----------------------------------------------

  private _handleAttach(modem: DiscoveredModem, isSeed: boolean): void {
    const key = modem.deviceId
    const isNew = !this._sessions.has(key)

    // Cancel gone timer
    const goneTimer = this._goneTimers.get(key)
    if (goneTimer !== undefined) {
      clearTimeout(goneTimer)
      this._goneTimers.delete(key)
    }

    // Get or create session
    let session = this._sessions.get(key)
    if (session === undefined) {
      session = new DeviceSession(key, modem.vendorId, modem.name, this._maxCycleHistory)
      this._sessions.set(key, session)
    }

    session.recordAttach(modem.productId, modem.name, modem)

    const snapshot = session.snapshot()
    const analysis = this._analyze(snapshot)

    if (isNew || (isSeed && !this._lastAnalysis.has(key))) {
      this._lastAnalysis.set(key, analysis)
      this.emit('device:appeared', snapshot, analysis)
      return
    }

    // Check for state change
    const previous = this._lastAnalysis.get(key)
    if (previous !== undefined && previous.state !== analysis.state) {
      this.emit('device:state-changed', snapshot, analysis, previous)
    }
    this._lastAnalysis.set(key, analysis)

    this.emit('device:attached', snapshot, analysis)
  }

  private _handleDetach(modem: DiscoveredModem): void {
    const key = modem.deviceId
    const session = this._sessions.get(key)
    if (session === undefined) return

    session.recordDetach()

    const snapshot = session.snapshot()
    const analysis = this._analyze(snapshot)

    // Check for state change
    const previous = this._lastAnalysis.get(key)
    if (previous !== undefined && previous.state !== analysis.state) {
      this.emit('device:state-changed', snapshot, analysis, previous)
    }
    this._lastAnalysis.set(key, analysis)

    this.emit('device:detached', snapshot, analysis)

    // Start gone timer
    this._goneTimers.set(
      key,
      setTimeout(() => {
        this._goneTimers.delete(key)
        const finalSnapshot = session.snapshot()
        this._sessions.delete(key)
        this._lastAnalysis.delete(key)
        this.emit('device:gone', finalSnapshot)
      }, this._goneTimeoutMs),
    )
  }

  // -- Analysis --------------------------------------------------------------

  private _analyze(snapshot: DeviceSessionSnapshot): DeviceStateAnalysis {
    // Try vendor-specific resolvers first
    for (const resolver of this._resolvers) {
      if (resolver.vendorId === snapshot.vendorId) {
        const result = resolver.analyze(snapshot)
        if (result !== undefined) return result
      }
    }

    // Generic fallback
    return genericAnalysis(snapshot)
  }
}

// -- Helpers -----------------------------------------------------------------

function genericAnalysis(snapshot: DeviceSessionSnapshot): DeviceStateAnalysis {
  if (snapshot.state === 'on-bus') {
    return {
      state: 'connected',
      severity: 'normal',
      description: `${snapshot.vendorName} is connected`,
      recommendations: [],
      expectedNextPid: undefined,
      estimatedRecoveryMs: undefined,
    }
  }

  return {
    state: 'disconnected',
    severity: 'normal',
    description: `${snapshot.vendorName} was disconnected`,
    recommendations: [],
    expectedNextPid: undefined,
    estimatedRecoveryMs: undefined,
  }
}
