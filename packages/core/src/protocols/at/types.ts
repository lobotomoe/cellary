import type { StkProactiveEvent } from '../../stk-types.js'

// ─── AT Command ──────────────────────────────────────────────────────────────

/** A command to send to the modem */
export interface ATCommand {
  /** Raw command string without trailing \r, e.g. 'AT+CSQ' */
  readonly raw: string
  /** Timeout in milliseconds */
  readonly timeout: number
  /** Whether to expect a `> ` prompt (for SMS PDU data entry) */
  readonly expectsPrompt?: boolean | undefined
  /** Data to send after receiving the `> ` prompt (hex PDU + Ctrl-Z appended automatically) */
  readonly promptData?: string | undefined
  /**
   * Suppress URC matching for this command's response lines.
   *
   * When true, the parser treats ALL response lines as info responses,
   * ignoring URC prefix matching. Required for AT+CLAC where response
   * lines are command names that collide with registered URC prefixes
   * (e.g. "+CREG", "+CUSD" would otherwise be swallowed as URCs).
   */
  readonly suppressURC?: boolean | undefined
}

/** Final result code from modem */
export type ATResultCode =
  | { readonly type: 'ok' }
  | { readonly type: 'error' }
  | { readonly type: 'cme_error'; readonly code: number; readonly message: string }
  | { readonly type: 'cms_error'; readonly code: number; readonly message: string }
  | { readonly type: 'no_carrier' }
  | { readonly type: 'busy' }
  | { readonly type: 'no_answer' }
  | { readonly type: 'no_dialtone' }

/** Result from executing an AT command */
export interface ATCommandResult {
  /** The original command string */
  readonly command: string
  /** The final result code */
  readonly status: ATResultCode
  /** Information response lines (without \r\n framing) */
  readonly lines: readonly string[]
}

// ─── Line Parser ─────────────────────────────────────────────────────────────

/** What the parser classifies each line as */
export type ParsedLine =
  | { readonly type: 'echo'; readonly raw: string }
  | { readonly type: 'info_response'; readonly raw: string }
  | { readonly type: 'urc'; readonly prefix: string; readonly body: string; readonly raw: string }
  | { readonly type: 'final_result'; readonly result: ATResultCode; readonly raw: string }
  | { readonly type: 'prompt' }
  | { readonly type: 'empty' }

/** Context the parser needs to classify a line */
export interface ParserContext {
  /** Command currently in-flight (null if idle) */
  readonly currentCommand: string | null
  /** Known URC prefixes */
  readonly urcPrefixes: ReadonlySet<string>
}

// ─── URC ─────────────────────────────────────────────────────────────────────

/**
 * AT Unsolicited Result Code.
 *
 * Structurally identical to UnsolicitedMessage (generic layer) —
 * TypeScript structural typing ensures assignability without an import.
 */
export interface URC {
  /** The prefix, e.g. '+CMTI' or 'RING' */
  readonly prefix: string
  /** Content after the prefix + colon, trimmed. Empty for prefix-only URCs like RING */
  readonly body: string
  /** Full raw line */
  readonly raw: string
}

/** Handler for a specific URC prefix */
export type URCHandler = (urc: URC) => void

// ─── Device Profile ──────────────────────────────────────────────────────────

/**
 * Device identity and optional protocol configuration.
 *
 * Separates two concerns:
 * - **Identity** (vendorId, name) -- used for plugin routing and display
 * - **AT configuration** (at) -- used only when the device speaks AT commands
 *
 * HTTP-only devices (e.g. Alcatel MW45V) have `at: undefined`.
 * AT-capable devices (e.g. Huawei E3372, ZTE MF656) provide full AT config.
 */
export interface DeviceProfile {
  /**
   * Stable identifier for plugin routing.
   *
   * Must exactly match the corresponding VendorPlugin.vendorId.
   * Undefined for the generic (no vendor) profile.
   */
  readonly vendorId?: string | undefined
  /** Human-readable name for logging and display */
  readonly name: string
  /** AT command protocol configuration. Undefined for non-AT devices. */
  readonly at?: AtConfig | undefined
}

// ─── AT Command Configuration ────────────────────────────────────────────────

/**
 * AT command protocol configuration for a device.
 *
 * Pure AT concerns: init commands, URC prefixes, timeouts, command overrides.
 * Carried inside DeviceProfile.at for devices that speak AT.
 */
export interface AtConfig {
  /** AT commands to send during initialization */
  readonly initCommands: readonly string[]
  /** URC prefixes this profile knows about */
  readonly urcPrefixes: readonly string[]
  /** Per-command timeout overrides (command prefix -> ms) */
  readonly commandTimeouts?: Readonly<Record<string, number>> | undefined
  /**
   * AT command overrides for vendor-specific syntax.
   *
   * Key = logical command name, value = AT command string.
   * Modules fall back to standard 3GPP commands when no override is present.
   *
   * Known keys:
   * - `iccid` -- ICCID query command (standard: 'AT+CCID')
   * - `voiceSetup` -- command to send before each voice call
   * - `stkEnable` -- STK enable command (required for STK support)
   * - `stkIndication` -- STK indication URC prefix (required for STK support)
   * - `stkGetInfo` -- STK get info command (required for STK support)
   * - `stkRespond` -- STK respond command (required for STK support)
   * - `chipTemp` -- chip temperature query
   * - `hardwareVersion` -- hardware version query
   */
  readonly commands?: Readonly<Record<string, string>> | undefined
  /**
   * Additional AT+CLAC command names for capability discovery.
   *
   * The generic capabilities module checks standard 3GPP commands.
   * Vendor profiles contribute additional command names to check
   * via this field.
   *
   * Each key maps to a capability; value is an array of CLAC-format
   * command names (e.g. ['^ICCID', '^SCID']).
   */
  readonly capabilityChecks?:
    | {
        readonly iccid?: readonly string[] | undefined
        readonly stk?: readonly string[] | undefined
      }
    | undefined
  /**
   * Vendor-specific enhanced signal query.
   *
   * When present, NetworkModule runs this command IN ADDITION to AT+CSQ and
   * merges the results. Provides RSRP/RSRQ/SINR/technology/band that the
   * standard +CSQ can't report.
   *
   * Example: Huawei `AT^HCSQ?` returns `^HCSQ: "LTE",rssi,rsrp,sinr,rsrq`.
   */
  readonly signal?: SignalQueryConfig | undefined
  /**
   * Vendor-specific traffic statistics query.
   *
   * When present, AtAdapter exposes a Traffic service using this command.
   * Without this, AT has no traffic capability (no 3GPP standard equivalent).
   *
   * Example: Huawei `AT^DSFLOWQRY` returns session + accumulated counters.
   */
  readonly traffic?: TrafficQueryConfig | undefined
  /**
   * Vendor-specific STK protocol configuration.
   * Required for SIM Toolkit support. Without this, StkModule throws on enable().
   */
  readonly stk?: StkConfig | undefined
}

// ─── STK Configuration ──────────────────────────────────────────────────────

/**
 * Vendor-specific STK command type mapping.
 *
 * Maps semantic proactive command names to vendor-specific numeric codes.
 * Different vendors use different numbering schemes:
 * - 3GPP BER-TLV uses tags like 0x21 (DISPLAY_TEXT), 0x24 (SELECT_ITEM)
 * - Some vendors use sequential numbering (0-12)
 */
export interface StkCommandTypes {
  readonly refresh: number
  readonly displayText: number
  readonly getInkey: number
  readonly getInput: number
  readonly playTone: number
  readonly selectItem: number
  readonly sendSms: number
  readonly sendSs: number
  readonly sendUssd: number
  readonly setupCall: number
  readonly setupIdleText: number
  readonly setupMenu: number
  readonly setupEventList: number
}

/** Vendor-specific terminal response qualifier codes. */
export interface StkResponseCodes {
  readonly ok: number
  readonly backward: number
  readonly noResponse: number
  readonly endSession: number
}

/**
 * Vendor-specific STK protocol configuration.
 *
 * Injected via AtConfig.stk. Without this, the StkModule cannot operate
 * (command types and response format are vendor-defined, not standardized).
 */
export interface StkConfig {
  /** Maps semantic command names to vendor-specific numeric codes */
  readonly commandTypes: StkCommandTypes
  /** Terminal response qualifier codes */
  readonly responseCodes: StkResponseCodes
  /** Numeric code for session-end indication */
  readonly sessionEndType: number
  /** Parse vendor-specific STGI response into a typed proactive event */
  readonly parseResponse: (commandType: number, lines: readonly string[]) => StkProactiveEvent
}

// ─── Signal Query ───────────────────────────────────────────────────────────

/**
 * Enhanced signal data returned by a vendor-specific signal command.
 *
 * Merged on top of the standard AT+CSQ result. All fields are optional --
 * only set what the vendor command provides.
 */
export interface EnhancedSignalData {
  readonly rssi?: number | undefined
  readonly technology?: string | undefined
  readonly rsrp?: number | undefined
  readonly rsrq?: number | undefined
  readonly sinr?: number | undefined
  readonly band?: string | undefined
}

/**
 * Vendor-specific signal query configuration.
 *
 * NetworkModule runs this command in addition to AT+CSQ and merges
 * the results. Provides RSRP/RSRQ/SINR/technology that standard
 * +CSQ can't report.
 */
export interface SignalQueryConfig {
  /** AT command to execute, e.g. 'AT^HCSQ?' */
  readonly command: string
  /** Parse the response lines into enhanced signal data */
  readonly parse: (lines: readonly string[]) => EnhancedSignalData
}

// ─── Traffic Query ──────────────────────────────────────────────────────────

/**
 * Traffic statistics returned by a vendor-specific traffic command.
 *
 * Maps directly to TrafficStats from the domain layer.
 * No 3GPP standard equivalent exists -- this is always vendor-specific.
 */
export interface TrafficQueryResult {
  readonly session: {
    readonly downloadBytes: number
    readonly uploadBytes: number
    readonly durationSeconds: number
  }
  readonly total: {
    readonly downloadBytes: number
    readonly uploadBytes: number
    readonly durationSeconds: number
  }
}

/**
 * Vendor-specific traffic statistics query configuration.
 *
 * When present, AtAdapter exposes a Traffic service backed by this command.
 * Example: Huawei `AT^DSFLOWQRY` returns session + accumulated hex counters.
 */
export interface TrafficQueryConfig {
  /** AT command to execute, e.g. 'AT^DSFLOWQRY' */
  readonly command: string
  /** Parse the response lines into traffic statistics */
  readonly parse: (lines: readonly string[]) => TrafficQueryResult
}

// ─── Per-Model Patches ──────────────────────────────────────────────────────

/**
 * Patches applied on top of the vendor profile for a specific model.
 * These are additive/override -- they don't replace the entire profile.
 */
export interface DeviceProfilePatches {
  /** AT config patches. Only meaningful for AT-capable devices. */
  readonly at?: AtConfigPatches | undefined
}

/**
 * AT-specific patches for per-model overrides.
 */
export interface AtConfigPatches {
  /** Additional init commands to append after the vendor's init sequence */
  readonly extraInitCommands?: readonly string[] | undefined
  /** Additional or overridden per-command timeouts */
  readonly commandTimeouts?: Readonly<Record<string, number>> | undefined
  /** Additional or overridden AT command strings */
  readonly commands?: Readonly<Record<string, string>> | undefined
}
