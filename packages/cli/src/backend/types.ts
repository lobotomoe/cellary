/**
 * Backend abstraction for CLI commands.
 *
 * Commands depend on DeviceHandle (domain interface), never on
 * Modem or DaemonClient directly. This allows transparent routing
 * between direct USB/serial access and daemon IPC.
 */

import type {
  AvailableNetwork,
  Capabilities,
  Data,
  Device,
  DeviceObserverEvents,
  DeviceObserverOptions,
  DiscoveredModem,
  ModelInfo,
  ModemEventMap,
  Network,
  PrepReport,
  ProtocolAdapter,
  ProvisionResult,
  ServiceRouteInfo,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  Traffic,
  Ussd,
  VendorPlugin,
  Voice,
} from 'cellary'

// ── DeviceHandle ────────────────────────────────────────────────────────────

/**
 * A connected device. Same service shape as Modem, but transport-agnostic:
 * works over direct serial/USB or daemon IPC.
 */
export interface DeviceHandle {
  // ── Services (reuses core interfaces verbatim) ────────────────────
  readonly network: Network
  readonly sms: Sms
  readonly sim: Sim
  readonly device: Device
  readonly voice: Voice
  readonly ussd: Ussd
  readonly traffic: Traffic
  readonly data: Data
  readonly capabilities: Capabilities
  readonly stk: Stk
  readonly system: System
  readonly thermal: Thermal

  // ── Modem-level operations ────────────────────────────────────────
  scanNetworks(): Promise<AvailableNetwork[]>
  selectNetwork(plmn: string): Promise<void>
  selectNetworkAutomatic(): Promise<void>

  // ── Metadata ──────────────────────────────────────────────────────
  readonly protocols: readonly string[]
  readonly httpUrl: string | undefined
  readonly model: ModelInfo | undefined
  readonly serviceRouting: Readonly<Record<string, ServiceRouteInfo>>

  // ── Events ────────────────────────────────────────────────────────
  on<K extends keyof ModemEventMap>(event: K, listener: (...args: ModemEventMap[K]) => void): void
  off<K extends keyof ModemEventMap>(event: K, listener: (...args: ModemEventMap[K]) => void): void

  // ── Lifecycle ─────────────────────────────────────────────────────
  close(): Promise<void>
  readonly isOpen: boolean

  // ── Direct-mode only (undefined in remote mode) ───────────────────
  readonly rawAccess: RawAccess | undefined
  readonly plugin: VendorPlugin | undefined
  readonly preparation: PrepReport | undefined
}

/**
 * Raw protocol access. Only available in direct mode.
 * Used by diagnose command and AT console.
 */
export interface RawAccess {
  adapter(kind: string): ProtocolAdapter | undefined
}

// ── DeviceWatcher ────────────────────────────────────────────────────────────

/**
 * Transport-agnostic device observation.
 *
 * In direct mode, wraps a real DeviceObserver (USB polling).
 * In remote mode, subscribes to daemon IPC events.
 */
export interface DeviceWatcher {
  on<K extends keyof DeviceObserverEvents>(
    event: K,
    listener: (...args: DeviceObserverEvents[K]) => void,
  ): void
  start(): void
  dispose(): void
}

// ── Backend ─────────────────────────────────────────────────────────────────

/**
 * Single access point for all modem interactions.
 *
 * In direct mode, wraps core's discover/provision/Modem directly.
 * In remote mode, delegates to daemon IPC. The daemon is the privileged
 * hardware gatekeeper — CLI users never need sudo when the daemon is running.
 */
export interface Backend {
  readonly mode: 'direct' | 'remote'

  // ── Fleet management ──────────────────────────────────────────────
  listDevices(): Promise<DiscoveredModem[]>
  provision(target: DiscoveredModem): Promise<ProvisionResult>
  createWatcher(options?: DeviceObserverOptions): DeviceWatcher

  // ── Device connection ─────────────────────────────────────────────
  connect(options?: ConnectOptions): Promise<DeviceHandle>

  // ── Lifecycle ─────────────────────────────────────────────────────
  dispose(): Promise<void>
}

export interface ConnectOptions {
  /** Serial port path or deviceId. Auto-detected if omitted. */
  readonly target?: string | undefined
  readonly verbose?: boolean | undefined
  /** Skip AT probe and init commands. */
  readonly autoInit?: boolean | undefined
}
