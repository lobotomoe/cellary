/**
 * Fleet-level modem lifecycle management types.
 *
 * Defines the per-device readiness state machine and the pool's event system.
 * The readiness pipeline drives each detected modem through:
 *   detected -> assessing -> preparing -> connecting -> checking -> ready
 */

import type { AuditSink } from '../audit.js'
import type {
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
} from '../discovery/observer-types.js'
import type { ProvisionResult } from '../discovery/provisioner.js'
import type { UsbModemEntry } from '../discovery/usb-types.js'
import type { Logger } from '../logger.js'
import type { Modem } from '../modem.js'
import type { PrepReport } from '../preparation/types.js'
import type { VendorPlugin } from '../protocols/adapter.js'

// ── Readiness state machine ─────────────────────────────────────────────────

/**
 * Per-device readiness stage.
 *
 * Each variant carries the data available at that stage.
 * The `modem` field only exists in 'ready' and 'degraded' -- before that
 * the Modem instance hasn't been created yet.
 */
export type DeviceReadiness =
  | { readonly stage: 'detected' }
  | { readonly stage: 'assessing'; readonly analysis?: DeviceStateAnalysis | undefined }
  | { readonly stage: 'preparing' }
  | { readonly stage: 'connecting'; readonly prepared: ProvisionResult }
  | { readonly stage: 'checking' }
  | { readonly stage: 'ready'; readonly modem: Modem; readonly report: PrepReport }
  | { readonly stage: 'degraded'; readonly modem: Modem; readonly report: PrepReport }
  | { readonly stage: 'error'; readonly error: Error; readonly recoverable: boolean }
  | { readonly stage: 'offline' }

/** Readiness stages where a live Modem is available. */
export type ReadyStage = Extract<DeviceReadiness, { stage: 'ready' | 'degraded' }>

// ── Pooled device ───────────────────────────────────────────────────────────

/** A device tracked by ModemPool. */
export interface PooledDevice {
  /** USB vendor ID. */
  readonly vendorId: number
  /** Human-readable name from USB database. */
  readonly name: string
  /** Current readiness state. */
  readonly readiness: DeviceReadiness
  /** DeviceObserver session snapshot (USB cycle history). */
  readonly session: DeviceSessionSnapshot
  /** When the device first appeared in this pool session. */
  readonly firstSeenAt: Date
}

// ── Pool events ─────────────────────────────────────────────────────────────

export interface PoolEventMap {
  /** Device entered the pool (first detection). */
  'device:added': [device: PooledDevice]
  /** Device readiness stage changed. */
  'device:readiness': [device: PooledDevice, previous: DeviceReadiness]
  /** Device removed from pool (offline + gone timeout). */
  'device:removed': [device: PooledDevice]
  /** A modem became ready (convenience: filtered readiness event). */
  'modem:ready': [device: PooledDevice, modem: Modem]
}

// ── Pool options ────────────────────────────────────────────────────────────

export interface PoolOptions {
  /** Vendor plugins to use. Default: DEFAULT_VENDORS from modem.ts. */
  readonly vendors?: ReadonlyMap<string, VendorPlugin> | undefined
  /** Device state resolvers for semantic analysis (boot-loop detection, etc.). Default: built-in vendor resolvers. */
  readonly resolvers?: readonly DeviceStateResolver[] | undefined
  /** Auto-start provisioning on detect? Default: true. */
  readonly autoProvision?: boolean | undefined
  /** Logger. */
  readonly logger?: Logger | undefined
  /**
   * Factory for a per-device audit sink. Called with each device's stable
   * deviceId when its modem is created, so the host (e.g. the daemon) can bind
   * a durable sink to a specific device. Omit to disable auditing.
   */
  readonly createAuditSink?: ((deviceId: string) => AuditSink) | undefined
  /** Maximum time (ms) a device stays offline before removal. Default: 300_000 (5 min). */
  readonly goneTimeoutMs?: number | undefined
  /** USB modem database for macOS pre-libusb mode switching. */
  readonly modemDatabase?: readonly UsbModemEntry[] | undefined
}
