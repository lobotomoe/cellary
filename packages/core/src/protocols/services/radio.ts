// ─── Radio Domain Types ──────────────────────────────────────────────────────

/**
 * Phone functionality level.
 *
 * Controls radio transmitter/receiver circuits.
 */
export type FunctionalityMode =
  | 'minimum' // minimum power draw, radio off
  | 'full' // full functionality, TX+RX on (default)
  | 'txDisabled' // transmit RF disabled (receive only)
  | 'rxDisabled' // receive RF disabled (transmit only)
  | 'airplane' // both TX and RX RF disabled
  | 'shutdown' // prepare for shutdown (NV flush, network detach)

/**
 * Extended error report from the last failed operation.
 *
 * The report format is manufacturer-determined. We expose the raw
 * report string and optionally parse structured cause codes when available.
 */
export interface ExtendedErrorReport {
  /** Raw report string as returned by the modem */
  readonly report: string
}

/** Overall activity state of the phone. */
export type PhoneActivityStatus =
  | 'ready' // ready to accept commands
  | 'unavailable' // unavailable
  | 'unknown' // status unknown
  | 'ringing' // incoming call ringing
  | 'callInProgress' // voice call in progress
  | 'asleep' // low power mode

/**
 * Wireless data service mode (radio access technology selection).
 *
 * Controls which radio technologies the modem is allowed to use.
 */
export type WirelessServiceMode =
  | 'gsm' // GSM only (2G)
  | 'utran' // UTRAN only (3G)
  | 'auto' // automatic 2G/3G/4G
  | 'lte' // LTE only (4G)
  | 'gsmAndUtran' // GSM + UTRAN (2G/3G)
  | 'gsmAndLte' // GSM + LTE (2G/4G)
  | 'utranAndLte' // UTRAN + LTE (3G/4G)
  | 'autoWith5g' // automatic including NR (2G/3G/4G/5G)
  | 'nrOnly' // NR only (5G)

/**
 * Power saving mode (PSM) configuration.
 *
 * All timer values are in seconds. Undefined means the timer
 * is not set or not returned by the modem.
 */
export interface PsmConfig {
  /** PSM enabled (true) or disabled (false) */
  readonly enabled: boolean
  /**
   * How long the modem sleeps between periodic updates to the network (seconds).
   * For LTE this is the periodic TAU interval; for 2G/3G the periodic RAU interval.
   * Undefined = not set / use network default.
   */
  readonly sleepDurationSeconds?: number | undefined
  /**
   * How long the modem stays reachable for paging after entering PSM (seconds).
   * Undefined = not set / use network default.
   */
  readonly activeDurationSeconds?: number | undefined
}

/**
 * eDRX access technology type.
 *
 * Identifies which radio access technology the eDRX configuration applies to.
 */
export type EDrxAccessType =
  | 'none' // not using eDRX (only in dynamic params)
  | 'ecGsmIot' // EC-GSM-IoT
  | 'gsm' // GSM
  | 'utran' // UTRAN (3G)
  | 'eutranWb' // E-UTRAN wideband (LTE Cat-M)
  | 'eutranNb' // E-UTRAN narrowband (NB-IoT)

/**
 * eDRX configuration for one access technology.
 *
 * The cycle duration is the interval between paging occasions in seconds.
 * Longer cycles save more power but increase latency for incoming data.
 */
export interface EDrxConfig {
  readonly accessType: EDrxAccessType
  /** eDRX cycle duration in seconds */
  readonly cycleDurationSeconds: number
}

/**
 * eDRX dynamic parameters from the currently registered cell.
 *
 * Shows what the network actually negotiated, which may differ
 * from what was requested.
 */
export interface EDrxDynamicParams {
  readonly accessType: EDrxAccessType
  /** Requested eDRX cycle duration in seconds */
  readonly requestedCycleSeconds?: number | undefined
  /** Network-assigned eDRX cycle duration in seconds */
  readonly networkCycleSeconds?: number | undefined
  /** Paging time window in seconds (how long the modem listens for pages) */
  readonly pagingWindowSeconds?: number | undefined
}

/** RRC signalling connection mode. */
export type SignallingConnectionMode = 'idle' | 'connected'

/**
 * Signalling connection status snapshot.
 *
 * Indicates whether the modem has an active RRC connection to the network.
 * 'idle' means the radio link is released (power saving).
 * 'connected' means an active radio link is maintained (data transfer possible).
 */
export interface SignallingConnectionStatus {
  readonly mode: SignallingConnectionMode
}

// ─── Radio Service Interface ─────────────────────────────────────────────────

/**
 * Radio power control, activity status, and error diagnostics.
 */
export interface Radio {
  /** Query current functionality mode. */
  functionality(): Promise<FunctionalityMode>
  /**
   * Set phone functionality level.
   *
   * @param mode - Target functionality mode
   * @param reset - When true, reset the MT before applying. Only valid with 'full' mode.
   */
  setFunctionality(mode: FunctionalityMode, reset?: boolean): Promise<void>
  /**
   * Extended error report for the last failed operation.
   *
   * Returns the cause of the last unsuccessful call setup, call release,
   * GPRS attach failure, or PDP context activation failure.
   * The report format is manufacturer-determined.
   */
  lastError(): Promise<ExtendedErrorReport>

  /**
   * Query phone activity status.
   *
   * Indicates overall MT state: ready, ringing, call in progress, asleep.
   */
  activityStatus?(): Promise<PhoneActivityStatus>

  /**
   * Query current wireless data service mode.
   *
   * Returns which radio access technologies the modem is using.
   */
  wirelessService?(): Promise<WirelessServiceMode>

  /**
   * Set wireless data service mode.
   *
   * Restricts which radio access technologies the modem will use.
   *
   * @param mode - Target mode (e.g. 'auto' for 2G/3G/4G, 'lte' for LTE only)
   */
  setWirelessService?(mode: WirelessServiceMode): Promise<void>

  // -- Power saving mode (IoT) --

  /** Query power saving mode (PSM) configuration. */
  powerSavingMode?(): Promise<PsmConfig>

  /**
   * Set power saving mode configuration.
   *
   * Timer values are in seconds. The AT module translates to the
   * appropriate wire format. Omit timers to leave at current/default.
   */
  setPowerSavingMode?(config: PsmConfig): Promise<void>

  /** Disable PSM and reset all timer parameters to manufacturer defaults. */
  resetPowerSavingMode?(): Promise<void>

  // -- eDRX (extended Discontinuous Reception) --

  /** Query eDRX settings for all configured access technology types. */
  edrxSettings?(): Promise<EDrxConfig[]>

  /**
   * Set eDRX configuration for a specific access technology.
   *
   * @param accessType - Radio access technology to configure
   * @param cycleDurationSeconds - Desired eDRX cycle duration in seconds
   */
  setEdrx?(accessType: EDrxAccessType, cycleDurationSeconds: number): Promise<void>

  /** Disable eDRX globally. */
  disableEdrx?(): Promise<void>

  /** Disable eDRX and reset all parameters to manufacturer defaults. */
  resetEdrx?(): Promise<void>

  /** Read current eDRX dynamic parameters from the registered cell. */
  edrxDynamicParams?(): Promise<EDrxDynamicParams>

  // -- Signalling connection --

  /** Query RRC signalling connection status (idle vs connected). */
  signallingConnection?(): Promise<SignallingConnectionStatus>
}
