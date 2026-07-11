// ─── Device Domain Types ─────────────────────────────────────────────────────

export interface DeviceInfo {
  /** Undefined when the modem does not respond (e.g. SIM-less TAF hang). */
  readonly manufacturer: string | undefined
  /** Device model name. Undefined when not reported by the device. */
  readonly model: string | undefined
  /** Firmware revision. Undefined when not reported by the device. */
  readonly revision: string | undefined
  /** Undefined when the modem does not respond (e.g. SIM-less TAF hang). */
  readonly imei: string | undefined
  /** Hardware revision string, e.g. "CL2E3372HM Ver.A". Vendor-specific, not always available. */
  readonly hardwareVersion?: string | undefined
}

/** Modem real-time clock information. */
export interface ClockInfo {
  /** Date and time from the modem RTC */
  readonly dateTime: Date
  /**
   * Time zone offset from UTC in minutes (-1440 to +1440).
   * Undefined when the modem does not report timezone.
   *
   * Example: +120 means UTC+2:00, -480 means UTC-8:00.
   */
  readonly timezoneOffsetMinutes?: number | undefined
}

/** Battery charge status. */
export type BatteryStatus =
  | 'batteryPowered' // ME is powered by the battery
  | 'batteryConnected' // battery connected but not powering ME
  | 'noBattery' // no battery connected
  | 'powerFault' // recognized power fault, calls inhibited

/** Battery charge information. */
export interface BatteryInfo {
  readonly status: BatteryStatus
  /** Battery charge level as a percentage (0-100). */
  readonly chargeLevel: number
}

/** Descriptor for a modem indicator (from CIND test response). */
export interface IndicatorDescriptor {
  /** Indicator name (e.g. "battchg", "signal", "service") */
  readonly name: string
  /** Minimum value in the indicator's range */
  readonly min: number
  /** Maximum value in the indicator's range */
  readonly max: number
}

/** Current indicator values read from the modem. */
export interface IndicatorReport {
  /** Indicator descriptors (ordered as reported by the modem) */
  readonly descriptors: readonly IndicatorDescriptor[]
  /** Named indicator values (e.g. { signal: 4, service: 1 }) */
  readonly values: Readonly<Record<string, number>>
}

/** Indicator value changed (from CIEV URC). */
export interface IndicatorChangeEvent {
  /** Indicator name (e.g. "signal", "battchg") */
  readonly name: string
  /** New value */
  readonly value: number
}

// ─── Device Service Interface ────────────────────────────────────────────────

export interface Device {
  info(): Promise<DeviceInfo>
  imei(): Promise<string>
  /**
   * Read the chip/CPU temperature in degrees Celsius.
   * Vendor-specific -- requires a profile with a `chipTemp` command override.
   * Returns undefined when the device doesn't support temperature reporting.
   */
  temperature?(): Promise<number | undefined>
  /**
   * Query the current TE character set.
   *
   * Common values: "GSM", "IRA", "UCS2", "UTF-8", "8859-1".
   */
  characterSet?(): Promise<string>
  /**
   * Set the TE character set used for string parameters.
   *
   * @param charset - Character set name (e.g. "GSM", "UCS2", "UTF-8")
   */
  setCharacterSet?(charset: string): Promise<void>

  /**
   * Read the modem real-time clock.
   *
   * Returns date/time and optional timezone offset in minutes from UTC.
   */
  clock?(): Promise<ClockInfo>

  /**
   * Set the modem real-time clock.
   *
   * @param dateTime - Date and time to set
   * @param timezoneOffsetMinutes - Optional timezone offset in minutes from UTC
   */
  setClock?(dateTime: Date, timezoneOffsetMinutes?: number): Promise<void>

  /** Enable or disable automatic time zone update from the network (NITZ). */
  setAutoTimezone?(enabled: boolean): Promise<void>

  /**
   * Read current modem indicator values.
   *
   * Returns named indicators (e.g. "battchg", "signal", "service") with
   * their current values and valid ranges. Indicator names and availability
   * are device-specific.
   */
  indicators?(): Promise<IndicatorReport>

  /**
   * Read battery charge status and level.
   *
   * Returns whether the device is battery-powered, connected to external power,
   * or has no battery, along with the charge percentage (0-100).
   */
  battery?(): Promise<BatteryInfo>
}
