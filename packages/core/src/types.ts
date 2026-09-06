import type {
  DataCapabilities,
  NetworkCapabilities,
  SimCapabilities,
  SmsCapabilities,
  StkCapabilities,
  UssdCapabilities,
  VoiceCapabilities,
} from './capability-types.js'
import type { PrepProfile } from './preparation/types.js'
import type { DeviceProfilePatches } from './protocols/at/types.js'
import type { IndicatorChangeEvent } from './protocols/services/device.js'
import type { RegistrationInfo } from './protocols/services/network.js'
import type { SmsNotification } from './protocols/services/sms.js'
import type { CallEvent, SsNotificationEvent } from './protocols/services/voice.js'

// ─── Transport ────────────────────────────────────────────────────────────────

/**
 * Physical byte-level communication with a modem.
 * Knows nothing about AT commands — just sends and receives bytes.
 */
export interface Transport {
  open(): Promise<void>
  close(): Promise<void>
  write(data: Uint8Array | string): Promise<void>
  onData(handler: (data: Uint8Array) => void): void
  /**
   * Register a handler called when the transport disconnects unexpectedly
   * (USB unplug, serial port gone, etc.). Not called on explicit close().
   */
  onDisconnect(handler: () => void): void
  readonly isOpen: boolean
  /**
   * Perform a hardware-level reset of the transport (e.g. USB bus reset).
   *
   * After reset the transport is closed — caller must re-open() it.
   * Not all transports support this; serial ports have no equivalent.
   */
  reset?(): Promise<void>
}

/**
 * Physical transport connection parameters.
 *
 * Describes HOW to connect to a modem at the byte/request level.
 * Does NOT describe the application protocol spoken over this connection
 * (e.g. AT commands, vendor HTTP API) — that is captured in PrepareResult.protocol.
 *
 * Each type maps 1:1 to a Transport implementation class:
 * - serial — classic serial port (ttyUSB, ttyACM, cu.*). No sudo needed.
 * - usb    — USB bulk endpoints via libusb. Needs elevated privileges on macOS.
 * - http   — HTTP connection (vendor API endpoint). Protocol is vendor-defined.
 */
export type TransportConfig =
  | {
      readonly type: 'serial'
      readonly path: string
      readonly baudRate?: number | undefined
    }
  | {
      readonly type: 'usb'
      readonly vendorId: number
      readonly productId: number
      readonly interfaceNumber: number
      /** Raise DTR/RTS on open. Required by Qualcomm serial_smd interfaces. */
      readonly assertDtr?: boolean | undefined
    }
  | {
      readonly type: 'http'
      readonly url: string
    }

// ─── Modem Driver ────────────────────────────────────────────────────────────

/**
 * How to talk to the modem — which driver to load.
 *
 * Structurally separates the standard path from vendor-specific extensions:
 * - `{ kind: 'at' }`              — standard 3GPP AT command protocol (serial, USB)
 * - `{ kind: 'vendor', api: ... }` — vendor-proprietary API (identified by `api` string)
 *
 * The structural asymmetry is intentional: AT has no extra fields because it IS
 * the standard. Vendor drivers need `api` to identify which implementation to load.
 */
export type ModemDriver =
  | { readonly kind: 'at' }
  | { readonly kind: 'vendor'; readonly api: string }

// ─── Device Profile (re-exports) ────────────────────────────────────────────

export type {
  AtConfig,
  AtConfigPatches,
  DeviceProfile,
  DeviceProfilePatches,
} from './protocols/at/types.js'

// ─── Per-Model Overrides ────────────────────────────────────────────────────

/**
 * Per-model modem metadata.
 *
 * Captures what a specific hardware model actually supports,
 * beyond what capability discovery reports. This is the "truth" layer
 * that corrects firmware lies and documents known limitations.
 *
 * ModelInfo is device-level (E3372), not vendor-level (Huawei).
 */
export interface ModelInfo {
  /** Human-readable model name, e.g. 'Huawei E3372' */
  readonly name: string

  /**
   * Capability overrides applied after runtime discovery.
   *
   * Each key matches a top-level field in ModemCapabilities.
   * Values are partial patches merged on top of runtime discovery.
   *
   * Example: `{ voice: { dial: false }, stk: { supported: false } }`
   * means "even if discovery says voice/STK is available, it doesn't work."
   */
  readonly capabilities?: CapabilityOverrides | undefined

  /**
   * Profile patches applied on top of the vendor profile.
   *
   * Allows a specific model to add init commands, change timeouts,
   * or override command strings beyond the vendor defaults.
   */
  readonly profilePatches?: DeviceProfilePatches | undefined

  /**
   * Per-model preparation profile.
   *
   * Declares which health checks to run and which known limitations to report
   * after the modem is opened. When set, takes priority over the vendor plugin's
   * preparationProfile() method.
   */
  readonly prepProfile?: PrepProfile | undefined
}

/**
 * Partial overrides for ModemCapabilities.
 * Only fields that differ from runtime discovery need to be specified.
 */
export interface CapabilityOverrides {
  readonly sms?: Partial<SmsCapabilities> | undefined
  readonly voice?: Partial<VoiceCapabilities> | undefined
  readonly network?: Partial<NetworkCapabilities> | undefined
  readonly sim?: Partial<SimCapabilities> | undefined
  readonly ussd?: Partial<UssdCapabilities> | undefined
  readonly data?: Partial<DataCapabilities> | undefined
  readonly stk?: Partial<StkCapabilities> | undefined
}

// ─── Unsolicited Messages ────────────────────────────────────────────────────

/**
 * A protocol-level message the modem sends without being asked.
 *
 * Protocol-agnostic: AT adapters produce these from URCs, HTTP adapters
 * from push notifications, etc. The Modem emits them as 'message' events
 * for consumers who need raw protocol visibility.
 */
export interface UnsolicitedMessage {
  /** Message category, e.g. '+CMTI', 'RING', or a vendor-specific tag */
  readonly prefix: string
  /** Payload after the category tag, trimmed. Empty for prefix-only messages. */
  readonly body: string
  /** Full raw line or payload as received from the protocol */
  readonly raw: string
}

// ─── Re-exports from service interfaces ──────────────────────────────────────
// Domain types now live next to their service interfaces.
// Re-exported here for backward compatibility — all existing imports keep working.

// Data Connection
export type {
  DataConnectionState,
  DataConnectionStatus,
  EpsQosParams,
  PdpAuthType,
  PdpContext,
  PdpDynamicParams,
  UeOperationMode,
} from './protocols/services/data.js'
// Device (IndicatorChangeEvent imported above for ModemEventMap)
export type {
  BatteryInfo,
  BatteryStatus,
  ClockInfo,
  DeviceInfo,
  IndicatorDescriptor,
  IndicatorReport,
} from './protocols/services/device.js'

// Network (RegistrationInfo imported above for ModemEventMap)
export type {
  AvailableNetwork,
  OperatorNameEntry,
  PreferredOperator,
  RegistrationStatus,
  SignalInfo,
} from './protocols/services/network.js'
// Phonebook
export type {
  PhonebookEntry,
  PhonebookStorage,
  PhonebookStorageInfo,
} from './protocols/services/phonebook.js'
// Radio
export type {
  EDrxAccessType,
  EDrxConfig,
  EDrxDynamicParams,
  ExtendedErrorReport,
  FunctionalityMode,
  PhoneActivityStatus,
  PsmConfig,
  SignallingConnectionMode,
  SignallingConnectionStatus,
  WirelessServiceMode,
} from './protocols/services/radio.js'
// SIM
export type { PinRetryInfo, SimInfo } from './protocols/services/sim.js'
// SMS (SmsNotification imported above for ModemEventMap)
export type { SmsCount, SmsMessage } from './protocols/services/sms.js'
// Traffic
export type { TrafficStats } from './protocols/services/traffic.js'
// Voice / Call (CallEvent, SsNotificationEvent imported above for ModemEventMap)
export type {
  CallEndReason,
  CallForwardingRule,
  CallForwardMode,
  CallForwardReason,
  CallState,
  ClirSetting,
  ClirStatus,
  MoSsNotification,
  MtSsNotification,
  NumberFormat,
} from './protocols/services/voice.js'
export type {
  CallEvent,
  IndicatorChangeEvent,
  RegistrationInfo,
  SmsNotification,
  SsNotificationEvent,
}

// ─── SIM State ──────────────────────────────────────────────────────────────

export type SimState =
  | 'ready'
  | 'pinRequired'
  | 'pukRequired'
  | 'pin2Required'
  | 'puk2Required'
  | 'networkLocked'
  | 'unknown'

/** SIM card state change event payload. */
export interface SimStateEvent {
  readonly state: SimState
}

// ─── Capabilities ───────────────────────────────────────────────────────────

export type {
  DataCapabilities,
  ModemCapabilities,
  NetworkCapabilities,
  SimCapabilities,
  SmsCapabilities,
  StkCapabilities,
  UssdCapabilities,
  VoiceCapabilities,
} from './capability-types.js'

// ─── Modem Events ────────────────────────────────────────────────────────────

/** All events the Modem can emit */
export interface ModemEventMap {
  // ── SMS ──
  'sms:received': [notification: SmsNotification]

  // ── Call ──
  /** Call lifecycle state changed. Single event for the entire call lifecycle. */
  'call:state': [info: CallEvent]

  // ── Network ──
  'network:registration': [info: RegistrationInfo]

  // ── SIM ──
  /** SIM card state changed (inserted, PIN required, ready, etc.) */
  'sim:state': [info: SimStateEvent]

  // ── Supplementary Service ──
  /** SS notification during voice call (forwarding active, call barred, etc.) */
  'call:supplementary': [event: SsNotificationEvent]

  // ── Indicators ──
  /** Modem indicator value changed (battery, signal level, service, etc.) */
  'indicator:change': [event: IndicatorChangeEvent]

  // ── System ──
  error: [error: Error]
  close: []
  open: []
  /** Transport disconnected unexpectedly. Reconnect may follow. */
  disconnect: []
  /** Successfully reconnected after a disconnect. */
  reconnect: []
  /** All reconnect attempts exhausted with no success. */
  'reconnect:failed': []

  // ── Debug ──
  /** Raw protocol message -- for debugging and monitoring tools only */
  'debug:raw': [message: UnsolicitedMessage]
}

// ─── Connection Progress ────────────────────────────────────────────────────

/** Progress event emitted during connection establishment. */
export interface ConnectionProgress {
  readonly phase: string
  readonly message: string
  readonly attempt?: number | undefined
  readonly maxAttempts?: number | undefined
}
