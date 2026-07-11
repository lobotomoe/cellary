/**
 * Types for system-level device state observation.
 *
 * DeviceObserver wraps the raw USB watch() events and groups them into
 * per-device sessions with temporal analysis. Vendor-pluggable resolvers
 * interpret session history into semantic states (boot-loop, mode-switch, etc.).
 */

import type { DiscoveredModem, UsbModemEntry } from './usb-types.js'

// -- USB cycle tracking ------------------------------------------------------

/** A single USB bus appearance/disappearance cycle for one device. */
export interface UsbCycle {
  readonly pid: number
  readonly name: string
  readonly attachedAt: number
  readonly detachedAt: number | undefined
  readonly modem: DiscoveredModem | undefined
}

// -- Session snapshot --------------------------------------------------------

/** Immutable snapshot of a device's observation history. */
export interface DeviceSessionSnapshot {
  /** Stable identity string derived from USB bus location (vendorId:busNumber-portPath). */
  readonly deviceId: string
  /** USB vendor ID. */
  readonly vendorId: number
  /** Human-readable vendor/device name from USB database. */
  readonly vendorName: string
  /** USB serial number when available (for future multi-device support). */
  readonly serialNumber: string | undefined
  /** Current cycle if on bus, undefined if off bus. */
  readonly currentCycle: UsbCycle | undefined
  /** Completed cycles, most recent first. Capped at maxCycleHistory. */
  readonly history: readonly UsbCycle[]
  /** Timestamp of first observation. */
  readonly firstSeenAt: number
  /** Whether the device is currently on the USB bus. */
  readonly state: 'on-bus' | 'off-bus'
  /** Number of completed (attach + detach) cycles. */
  readonly completedCycleCount: number
  /** Average on-bus duration across completed cycles. Undefined when < 2 cycles. */
  readonly avgOnBusDurationMs: number | undefined
  /** Average off-bus gap between cycles. Undefined when < 2 cycles. */
  readonly avgOffBusDurationMs: number | undefined
}

// -- State analysis ----------------------------------------------------------

export type DeviceSeverity = 'normal' | 'degraded' | 'critical'

/** Semantic interpretation of a device's current behavior. */
export interface DeviceStateAnalysis {
  /** Vendor-defined state name: 'thermal-boot-loop', 'stable', 'edl-mode', etc. */
  readonly state: string
  readonly severity: DeviceSeverity
  /** Human-readable explanation of what's happening. */
  readonly description: string
  /** Actionable steps the user can take. */
  readonly recommendations: readonly string[]
  /** If the device is expected to reappear, at which PID. */
  readonly expectedNextPid: number | undefined
  /** Estimated time until recovery (ms), if predictable from cycle timing. */
  readonly estimatedRecoveryMs: number | undefined
}

// -- Resolver interface ------------------------------------------------------

/**
 * Stateless vendor-specific analyzer.
 *
 * Given a session snapshot, returns a semantic analysis or undefined
 * if this resolver doesn't recognize the device.
 */
export interface DeviceStateResolver {
  readonly vendorId: number
  analyze(session: DeviceSessionSnapshot): DeviceStateAnalysis | undefined
}

// -- Observer events ---------------------------------------------------------

export interface DeviceObserverEvents {
  /** First time this device is seen on the bus. */
  'device:appeared': [session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis]
  /** Device (re)appeared on the USB bus. */
  'device:attached': [session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis]
  /** Device left the USB bus. */
  'device:detached': [session: DeviceSessionSnapshot, analysis: DeviceStateAnalysis]
  /** Resolver analysis changed (e.g. 'cold-start' -> 'thermal-boot-loop'). */
  'device:state-changed': [
    session: DeviceSessionSnapshot,
    analysis: DeviceStateAnalysis,
    previous: DeviceStateAnalysis,
  ]
  /** Device has been offline longer than goneTimeoutMs. Session cleaned up. */
  'device:gone': [session: DeviceSessionSnapshot]
}

// -- Observer options --------------------------------------------------------

export interface DeviceObserverOptions {
  /** Vendor-specific resolvers. Matched by vendorId. */
  readonly resolvers?: readonly DeviceStateResolver[] | undefined
  /** Maximum completed cycles to keep per session. Default: 20. */
  readonly maxCycleHistory?: number | undefined
  /** How long (ms) after last detach before emitting 'device:gone'. Default: 300_000 (5 min). */
  readonly goneTimeoutMs?: number | undefined
  /**
   * USB modem database entries (macOS only).
   * When provided, the observer runs a pre-libusb preflight on macOS that ejects
   * storage-mode devices via `diskutil` before libusb opens any IOKit handles.
   */
  readonly modemDatabase?: readonly UsbModemEntry[] | undefined
}
