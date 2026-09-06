// ─── SIM Domain Types ────────────────────────────────────────────────────────

export interface SimInfo {
  /** ICCID. Undefined when SIM is absent or unreadable. */
  readonly iccid: string | undefined
  readonly imsi?: string | undefined
  readonly operator?: string | undefined
  readonly state:
    | 'ready'
    | 'pinRequired'
    | 'pukRequired'
    | 'networkLocked'
    | 'absent'
    | 'error'
    | 'unavailable'
}

/**
 * Remaining PIN/PUK retry counts.
 *
 * Shows how many attempts remain before each code is permanently blocked.
 * PIN exhaustion requires PUK entry. PUK exhaustion bricks the SIM card.
 */
export interface PinRetryInfo {
  /** Remaining PIN1 attempts (0 = blocked, need PUK) */
  readonly pin: number
  /** Remaining PUK1 attempts (0 = SIM permanently blocked) */
  readonly puk: number
  /** Remaining PIN2 attempts. Undefined when not reported. */
  readonly pin2?: number | undefined
  /** Remaining PUK2 attempts. Undefined when not reported. */
  readonly puk2?: number | undefined
}

// ─── SIM Service Interface ───────────────────────────────────────────────────

export interface Sim {
  info(): Promise<SimInfo>
  iccid(): Promise<string>
  imsi(): Promise<string>
  enterPin(pin: string): Promise<void>
  /** Subscriber phone number (MSISDN). Not all SIMs or protocols expose this. */
  phoneNumber?(): Promise<string | undefined>
  /**
   * Remaining PIN/PUK retry counts.
   *
   * Returns how many attempts remain for PIN1, PUK1, and optionally PIN2/PUK2.
   */
  pinRetries?(): Promise<PinRetryInfo>
  /**
   * Query whether a facility is locked.
   *
   * Common facilities: "SC" (SIM PIN), "FD" (fixed dialling), "PN" (network lock).
   */
  queryFacilityLock?(facility: string, serviceClass?: number): Promise<boolean>
  /**
   * Lock or unlock a facility.
   *
   * @param facility - Facility code (e.g. "SC" for SIM PIN)
   * @param lock - true to enable, false to disable
   * @param password - Required for most facilities (PIN, barring password)
   * @param serviceClass - Optional service class (1=voice, 2=data, etc.)
   */
  setFacilityLock?(
    facility: string,
    lock: boolean,
    password?: string,
    serviceClass?: number,
  ): Promise<void>
  /**
   * Change the password for a facility.
   *
   * Common use: changing SIM PIN ("SC"), SIM PIN2 ("P2"), call barring password ("AB").
   */
  changePassword?(facility: string, oldPassword: string, newPassword: string): Promise<void>
}
