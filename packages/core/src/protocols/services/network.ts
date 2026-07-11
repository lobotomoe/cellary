// ─── Network Domain Types ────────────────────────────────────────────────────

export interface SignalInfo {
  /** Signal strength in dBm (converted from 0-31 CSQ scale). Undefined when not detectable. */
  readonly rssi: number | undefined
  /** Bit error rate (0-7, 99 = not detectable) */
  readonly bitErrorRate: number
  /** Radio access technology, e.g. 'LTE', 'UMTS', 'GSM' */
  readonly technology?: string | undefined
  /** Reference Signal Received Power in dBm (LTE). Typical: -44 to -140. */
  readonly rsrp?: number | undefined
  /** Reference Signal Received Quality in dB (LTE). Typical: -3 to -20. */
  readonly rsrq?: number | undefined
  /** Signal to Interference+Noise Ratio in dB (LTE). Typical: -20 to 30. */
  readonly sinr?: number | undefined
  /** Frequency band identifier, e.g. "B7", "B3" */
  readonly band?: string | undefined
  /** Received Signal Code Power in dBm (WCDMA/UMTS). Typical: -120 to -25. */
  readonly rscp?: number | undefined
  /** Ratio of energy per chip to noise in dB (WCDMA/UMTS Ec/No). Typical: -24 to 0. */
  readonly ecno?: number | undefined
}

export type RegistrationStatus =
  | 'notRegistered'
  | 'home'
  | 'searching'
  | 'denied'
  | 'unknown'
  | 'roaming'

export interface RegistrationInfo {
  readonly status: RegistrationStatus
  /** Location Area Code (hex string). Undefined when not reported. */
  readonly locationAreaCode?: string | undefined
  readonly cellId?: string | undefined
  readonly technology?: string | undefined
}

/** Operator name entry from modem firmware database. */
export interface OperatorNameEntry {
  /** PLMN code (MCC+MNC), e.g. "28301" */
  readonly numeric: string
  /** Long alphanumeric name, e.g. "Orange Armenia" */
  readonly name: string
}

/**
 * Preferred operator entry from SIM.
 *
 * Each entry specifies a PLMN and which access technologies are preferred.
 * The index is the 1-based position in the SIM's preferred PLMN list.
 */
export interface PreferredOperator {
  /** 1-based position in the preferred PLMN list */
  readonly index: number
  /** PLMN code (MCC+MNC), e.g. "28301" */
  readonly numeric: string
  /** GSM access technology preferred */
  readonly gsm: boolean
  /** UTRAN (3G) access technology preferred */
  readonly utran: boolean
  /** E-UTRAN (LTE) access technology preferred */
  readonly eutran: boolean
  /** NR (5G) access technology preferred. Undefined when modem doesn't report it. */
  readonly nr?: boolean | undefined
}

export interface AvailableNetwork {
  /** Operator selection status */
  readonly status: 'unknown' | 'available' | 'current' | 'forbidden'
  /** Long operator name, e.g. "UCOM". Undefined when not provided by the device. */
  readonly name: string | undefined
  /** Short operator name, e.g. "UCOM". Undefined when not provided by the device. */
  readonly shortName: string | undefined
  /** PLMN code (MCC+MNC), e.g. "28301" */
  readonly numeric: string
  /** Radio access technology, e.g. 'LTE', 'GSM' */
  readonly technology?: string | undefined
}

// ─── Network Service Interface ───────────────────────────────────────────────

export interface Network {
  signal(): Promise<SignalInfo>
  registration(): Promise<RegistrationInfo>
  /** Current operator name. Undefined when not registered or not available. */
  operator(): Promise<string | undefined>
  /** Scan for available networks. Slow: typically 30-120 seconds. */
  scan?(): Promise<AvailableNetwork[]>
  /** Manually select a network operator by PLMN code (MCC+MNC). */
  selectOperator?(plmn: string): Promise<void>
  /** Return to automatic network selection. */
  selectAutomatic?(): Promise<void>
  /**
   * EPS/LTE registration status.
   *
   * Similar to registration() but for the EPS/LTE domain.
   * Returns TAC (tracking area code) instead of LAC.
   */
  epsRegistration?(): Promise<RegistrationInfo>
  /**
   * GPRS/PS registration status.
   *
   * Same shape as registration() but for the GPRS/PS domain.
   */
  gprsRegistration?(): Promise<RegistrationInfo>
  /**
   * Read operator name database from modem firmware memory.
   *
   * Dumps all stored numeric-to-name mappings. The list comes from
   * modem firmware, not the SIM card. Can be large (hundreds of entries).
   */
  operatorNames?(): Promise<OperatorNameEntry[]>
  /**
   * Read the preferred operator list from SIM.
   *
   * Returns entries with PLMN codes and preferred access technologies.
   */
  preferredOperators?(): Promise<PreferredOperator[]>
  /**
   * Add or update a preferred operator entry on the SIM.
   *
   * @param index - 1-based position in the preferred PLMN list
   * @param numeric - PLMN code (MCC+MNC)
   * @param gsm - Prefer GSM access technology
   * @param utran - Prefer UTRAN (3G) access technology
   * @param eutran - Prefer E-UTRAN (LTE) access technology
   */
  setPreferredOperator?(entry: {
    readonly index: number
    readonly numeric: string
    readonly gsm?: boolean
    readonly utran?: boolean
    readonly eutran?: boolean
  }): Promise<void>
  /** Delete a preferred operator entry by index. */
  removePreferredOperator?(index: number): Promise<void>
}
