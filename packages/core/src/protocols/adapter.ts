import type { DeviceIdentification, DiscoveredModem } from '../discovery/usb-types.js'
import type { Flasher, FlasherOptions } from '../firmware.js'
import type { Logger } from '../logger.js'
import type { PrepProfile } from '../preparation/types.js'
import type {
  CallEvent,
  DeviceProfile,
  ModelInfo,
  RegistrationInfo,
  SimStateEvent,
  SmsCount,
  SmsNotification,
  TransportConfig,
  UnsolicitedMessage,
} from '../types.js'
import type {
  Capabilities,
  Data,
  Device,
  Network,
  Phonebook,
  Radio,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  Traffic,
  Ussd,
  Voice,
} from './services/index.js'

// Re-export all service interfaces so existing `import { X } from './adapter.js'` still works
export type {
  ActiveCall,
  CallWaitingStatus,
  Capabilities,
  CpuFrequency,
  Data,
  Device,
  InteractiveStream,
  Network,
  Phonebook,
  Radio,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  ThermalReading,
  Traffic,
  Ussd,
  Voice,
} from './services/index.js'

// ── Service capability metadata ──────────────────────────────────────────────

/** Service names that participate in priority routing. */
export type ServiceName =
  | 'network'
  | 'sms'
  | 'sim'
  | 'device'
  | 'voice'
  | 'ussd'
  | 'stk'
  | 'capabilities'
  | 'traffic'
  | 'data'
  | 'radio'
  | 'phonebook'
  | 'system'
  | 'thermal'

/**
 * Declares an adapter's quality/suitability for a specific service.
 *
 * Priority convention:
 *   10  -- best available (rich data, full feature set, no known issues)
 *    5  -- functional but limited (e.g. RSSI-only signal, no PIN entry)
 *    0  -- default for adapters that don't declare serviceCapabilities()
 *   -1  -- present but severely limited (e.g. count-only SMS, read-only)
 *
 * When two adapters tie, array order from discoverAdapters() breaks the tie.
 * The `reason` field is shown in CLI diagnostics (e.g. "via HTTP API (rich signal data)").
 */
export interface ServiceCapability {
  /** Higher wins. Adapters without serviceCapabilities() default to 0. */
  readonly priority: number
  /** Human-readable reason, shown in CLI when the service is contested. */
  readonly reason: string
}

/** Routing decision metadata for a single service. */
export interface ServiceRouteInfo {
  /** Which adapter kind handles this service. */
  readonly adapter: string
  /** Why this adapter was chosen (from ServiceCapability.reason). */
  readonly reason: string
  /** True when 2+ adapters competed for this service. */
  readonly contested: boolean
}

// ── Protocol adapter ─────────────────────────────────────────────────────────

/**
 * A protocol adapter provides some or all modem services.
 *
 * Each optional field represents a service the adapter can serve.
 * Undefined means the adapter cannot handle that domain.
 *
 * Examples:
 * - AtAdapter: implements all services via AT commands over serial/USB
 * - Vendor HTTP adapter: implements network and USSD via vendor HTTP API
 */
export interface ProtocolAdapter {
  /** Identifier for logging and diagnostics, e.g. 'at' or 'http' */
  readonly kind: string
  /** Base URL for HTTP-based adapters. Undefined for serial/USB-only adapters. */
  readonly baseUrl?: string | undefined
  readonly network?: Network | undefined
  readonly sms?: Sms | undefined
  readonly sim?: Sim | undefined
  readonly device?: Device | undefined
  readonly voice?: Voice | undefined
  readonly ussd?: Ussd | undefined
  readonly stk?: Stk | undefined
  readonly traffic?: Traffic | undefined
  readonly data?: Data | undefined
  readonly radio?: Radio | undefined
  readonly phonebook?: Phonebook | undefined
  readonly capabilities?: Capabilities | undefined
  readonly system?: System | undefined
  readonly thermal?: Thermal | undefined
  /**
   * SMS storage count for adapters that can count but not send/list/read/delete.
   * When present, Modem enriches the primary sms service with this count method.
   */
  smsCount?(): Promise<SmsCount>
  /**
   * Send initialization commands. Called by Modem after all adapters are connected,
   * before emitting 'open'. Non-fatal step failures are reported via onError so that
   * init can continue even when individual steps fail (e.g. optional AT commands).
   *
   * onProgress is called during retries/probing to report connection status.
   */
  init?(
    onError?: (step: string, err: Error) => void,
    onProgress?: (event: {
      phase: string
      message: string
      attempt?: number
      maxAttempts?: number
    }) => void,
  ): Promise<void>
  /** Start background activity (polling, monitoring). Called by Modem after init. */
  start?(): void
  /** Stop background activity. Called by Modem on close. */
  stop?(): void
  /** Tear down the adapter's connection (close transport, dispose channel, etc.). */
  close?(): Promise<void>
  /**
   * Register a handler called when the underlying transport disconnects unexpectedly.
   * Adapters without a persistent connection (e.g. HTTP polling) do not implement this.
   */
  onDisconnect?(handler: () => void): void
  /**
   * Re-open the transport after a disconnect.
   * Called by Modem's reconnect loop. Only adapters that implement onDisconnect need
   * to implement this -- they go together.
   */
  reopen?(): Promise<void>
  /**
   * Perform a hardware-level reset of the underlying transport.
   *
   * After reset the adapter is closed and unusable. The caller must
   * re-discover and re-connect the device (USB re-enumeration takes ~2-3s).
   * Only implemented by adapters with resettable transports (e.g. USB).
   */
  reset?(): Promise<void>
  /**
   * Declare quality metadata for each service this adapter provides.
   *
   * Called once during Modem construction to determine routing priority.
   * Return entries only for services this adapter actually provides.
   *
   * Adapters that don't implement this method get priority 0 for all
   * their services -- backward compatible with existing adapters.
   */
  serviceCapabilities?(): Partial<Record<ServiceName, ServiceCapability>>
}

// ── Vendor plugin ─────────────────────────────────────────────────────────────

/**
 * Execute one AT command and return the response lines.
 * Silently returns an empty array on timeout or error.
 * Passed to VendorPlugin.diagnose() so the plugin can probe the modem
 * without holding a reference to the full Modem class.
 */
export type VendorProbe = (cmd: string) => Promise<readonly string[]>

/**
 * Typed event that a vendor plugin extracts from a raw unsolicited message.
 * Adapters re-emit these as first-class events on the Modem EventEmitter.
 *
 * Open to all event categories -- not limited to calls.
 */
export type VendorEvent =
  | { readonly event: 'call:state'; readonly data: CallEvent }
  | { readonly event: 'sms:received'; readonly data: SmsNotification }
  | { readonly event: 'network:registration'; readonly data: RegistrationInfo }
  | { readonly event: 'sim:state'; readonly data: SimStateEvent }

/**
 * Result of adapter discovery by a vendor plugin.
 *
 * Includes the discovered adapters and an optional runtime-resolved model.
 * USB PIDs are often shared across multiple devices from the same vendor.
 * When the USB PID alone cannot identify the model, the plugin queries
 * the device at runtime (e.g. via vendor HTTP API) and returns the resolved model.
 */
export interface AdapterDiscoveryResult {
  readonly adapters: readonly ProtocolAdapter[]
  /** Runtime-resolved model, overrides the USB-database model when present. */
  readonly model?: ModelInfo | undefined
}

/**
 * A vendor plugin groups all protocol adapters for a hardware vendor.
 *
 * Register a plugin with Modem.detect() to enable vendor-specific protocols
 * (proprietary HTTP APIs, custom USB protocols, etc.). Each plugin handles
 * all adapter variants for its vendor -- plug in the vendor, get everything.
 *
 * @example
 * ```ts
 * // With all built-in vendors (default)
 * const modem = await Modem.detect()
 *
 * // Or extend with a custom vendor
 * const vendors = new Map(DEFAULT_VENDORS)
 * vendors.set(myPlugin.vendorId, myPlugin)
 * const modem = await Modem.detect(undefined, { vendors })
 * ```
 */
export interface VendorPlugin {
  /**
   * Stable identifier for plugin-to-profile matching.
   *
   * Must exactly match the corresponding DeviceProfile.vendorId.
   * Used by Modem.connectFromPrepared() to find the right plugin for a device.
   */
  readonly vendorId: string
  /** Display name for logging and diagnostics */
  readonly name: string
  /**
   * Discover all protocol adapters available for this device.
   *
   * Called by Modem.detect() with the physical transport resolved by prepare().
   * The plugin decides which adapters to create based on the transport type and
   * any reachability probes it performs (e.g. attempting an HTTP request to check
   * if a vendor HTTP API is reachable alongside the AT serial interface).
   *
   * Return adapters in the order they should be tried. Per-service routing
   * is determined by each adapter's serviceCapabilities() declaration;
   * array order serves as tiebreaker when priorities are equal. Return an
   * empty array if this plugin cannot handle the given transport.
   *
   * When the device model cannot be determined from USB PID alone (shared PIDs),
   * the plugin may resolve the model at runtime (e.g. querying a vendor HTTP API).
   * Return a `model` field in the result to override the USB-database model.
   *
   * Examples:
   * - Device with serial + HTTP (serial/USB transport) -> [HttpAdapter, AtAdapter]
   *   HTTP adapter has priority: richer signal data, fewer AT quirks
   * - Device with HTTP only (http transport) -> [HttpAdapter]
   * - Device with AT only (no vendor API reachable) -> [AtAdapter]
   */
  discoverAdapters(
    transport: TransportConfig,
    profile: DeviceProfile,
    model: ModelInfo | undefined,
    opts?: {
      readonly defaultTimeout?: number | undefined
      readonly logger?: Logger | undefined
    },
  ): Promise<AdapterDiscoveryResult>
  /**
   * Decode a vendor-specific unsolicited message into a human-readable string.
   * Return undefined if the message is not recognised by this plugin.
   */
  decodeMessage?(message: UnsolicitedMessage): string | undefined
  /**
   * Run vendor-specific diagnostics using the provided probe function.
   * Returns label-value pairs ready for display.
   */
  diagnose?(probe: VendorProbe): Promise<readonly [string, string][]>
  /**
   * Return a preparation profile for the given discovered modem.
   *
   * The profile declares which health checks to run after the modem is opened
   * and which known limitations to report. If undefined is returned, the
   * generic preparation profile is used (SIM + registration checks, no limitations).
   *
   * This is how vendors declare "my device has THESE limitations and needs
   * THESE checks" without writing custom preparation code.
   */
  preparationProfile?(
    discovered: { readonly vendorId: number; readonly productId: number },
    model: ModelInfo | undefined,
  ): PrepProfile | undefined
  /**
   * Lightweight identification probe for display purposes.
   *
   * Called by identify() after discovery to enrich a DiscoveredModem
   * with model name and expected protocols. Must be fast (< 3s) and
   * non-destructive (no auth, no state changes, no connection creation).
   *
   * Returns undefined if the plugin cannot identify this device.
   */
  identify?(discovered: DiscoveredModem): Promise<DeviceIdentification | undefined>
  /**
   * Create a firmware flasher for the given USB device.
   *
   * Flashing is NOT a modem service -- it disconnects the modem, uses a
   * different protocol (USB bulk, vendor binary framing), and requires reboot.
   * Returns undefined if this plugin does not support flashing.
   */
  createFlasher?(options: FlasherOptions): Flasher | undefined
}
