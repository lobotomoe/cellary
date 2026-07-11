import { ATError, ParseError } from '../../../errors.js'
import type {
  BatteryInfo,
  ClockInfo,
  DeviceInfo,
  IndicatorDescriptor,
  IndicatorReport,
} from '../../../types.js'
import type { Device } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// +CSCS: "<charset>"
const CSCS_REGEX = /\+CSCS:\s*"([^"]*)"/

// +CIND=? test response: ("name",(min-max)),("name",(min-max)),...
const CIND_DESCRIPTOR_REGEX = /\("([^"]+)",\((\d+)-(\d+)\)\)/g

// +CIND? read response: +CIND: v1,v2,v3,...
const CIND_VALUES_REGEX = /\+CIND:\s*([\d,]+)/

// AT+CGSN IMEI response. Most modems return the bare 15-digit IMEI, but some
// (e.g. Qualcomm) echo a "+CGSN:" / "+GSN:" prefix. Strip it when present.
const CGSN_PREFIX_REGEX = /^\+?C?GSN:\s*/i

function normalizeImei(line: string): string {
  return line.replace(CGSN_PREFIX_REGEX, '').trim()
}

// 3GPP TS 27.007 Section 8.15 -- AT+CCLK
// +CCLK: "yy/MM/dd,hh:mm:ss±zz"
// Timezone part (±zz) is optional. Quotes around the value are optional on some modems.
const CCLK_REGEX = /\+CCLK:\s*"?(\d{2,4})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([-+]\d+)?"?/

// 3GPP TS 27.007 Section 8.4 -- AT+CBC
// +CBC: <bcs>,<bcl>
// bcs: 0=battery powered, 1=battery connected (not powering), 2=no battery, 3=power fault
// bcl: charge level 0-100 (percentage)
const CBC_REGEX = /\+CBC:\s*(\d+),(\d+)/

/** Map +CBC bcs code to domain BatteryStatus. */
function parseBatteryStatusCode(code: number): BatteryInfo['status'] | undefined {
  switch (code) {
    case 0:
      return 'batteryPowered'
    case 1:
      return 'batteryConnected'
    case 2:
      return 'noBattery'
    case 3:
      return 'powerFault'
    default:
      return undefined
  }
}

// Reasonable temperature range for cellular chipsets (degrees Celsius)
const MIN_TEMP = 5
const MAX_TEMP = 120

/**
 * Parse a chip temperature response into degrees Celsius.
 *
 * Handles comma-separated multi-sensor formats (e.g. "34,31,21,42,10000").
 * Values outside 5-120 C are filtered (thresholds, sentinels).
 * Returns the highest value in range, which is typically the hottest sensor.
 */
function parseChipTemperature(line: string): number | undefined {
  // Strip response prefix (e.g. "^CHIPTEMP: ")
  const numericPart = line.replace(/^[^:]*:\s*/, '')
  const values = numericPart.split(',').map((s) => Number(s.trim()))
  const temps = values.filter((v) => !Number.isNaN(v) && v >= MIN_TEMP && v <= MAX_TEMP)
  return temps.length > 0 ? Math.max(...temps) : undefined
}

/** Query modem hardware identity and capabilities */
export class DeviceModule implements Device {
  private readonly channel: ATChannel
  private readonly profile: AtConfig

  /** Cached indicator descriptors from AT+CIND=? (lazily loaded) */
  private _indicatorDescriptors: IndicatorDescriptor[] | undefined

  constructor(channel: ATChannel, profile: AtConfig) {
    this.channel = channel
    this.profile = profile
  }

  /** Query device manufacturer, model, revision, and IMEI */
  async info(): Promise<DeviceInfo> {
    const [mfrResult, mdlResult, revResult, imeiResult] = await Promise.allSettled([
      this.channel.execute('AT+CGMI'),
      this.channel.execute('AT+CGMM'),
      this.channel.execute('AT+CGMR'),
      this.channel.execute('AT+CGSN'),
    ])

    const manufacturer = mfrResult.status === 'fulfilled' ? mfrResult.value.lines[0] : undefined
    const model = mdlResult.status === 'fulfilled' ? mdlResult.value.lines[0] : undefined
    const revision = revResult.status === 'fulfilled' ? revResult.value.lines[0] : undefined
    const imeiLine = imeiResult.status === 'fulfilled' ? imeiResult.value.lines[0] : undefined
    const imei = imeiLine !== undefined ? normalizeImei(imeiLine) : undefined

    // Best-effort hardware version query (vendor-specific, optional)
    let hardwareVersion: string | undefined
    const hwCmd = this.profile.commands?.hardwareVersion
    if (hwCmd !== undefined) {
      try {
        const hwResult = await this.channel.execute(hwCmd)
        const hwLine = hwResult.lines[0]
        if (hwLine !== undefined) {
          // Strip response prefix (e.g. "^HWVER: ") if present
          hardwareVersion = hwLine.replace(/^\^?\w+:\s*/, '').trim()
          // Unquote if wrapped in double quotes
          if (hardwareVersion.startsWith('"') && hardwareVersion.endsWith('"')) {
            hardwareVersion = hardwareVersion.slice(1, -1)
          }
        }
      } catch {
        // Non-critical: hardware version is optional
      }
    }

    return { manufacturer, model, revision, imei, hardwareVersion }
  }

  /** Query IMEI */
  async imei(): Promise<string> {
    const result = await this.channel.execute('AT+CGSN')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CGSN returned no data', result.lines.join('\n'))
    }
    return normalizeImei(line)
  }

  /**
   * Read the chip/CPU temperature in degrees Celsius.
   *
   * Uses the vendor-specific command from profile.commands.chipTemp.
   * Returns undefined when the profile has no temperature command or
   * the modem returns an unparseable response.
   */
  async temperature(): Promise<number | undefined> {
    const cmd = this.profile.commands?.chipTemp
    if (cmd === undefined) return undefined

    try {
      const result = await this.channel.execute(cmd)
      const line = result.lines[0]
      if (line === undefined) return undefined
      return parseChipTemperature(line)
    } catch (err) {
      if (!(err instanceof ATError)) throw err
      return undefined
    }
  }

  /**
   * Query the current TE character set via AT+CSCS?
   *
   * Response: +CSCS: "<charset>"
   * Common values: "GSM", "IRA", "UCS2", "UTF-8", "8859-1"
   *
   * Ref: 3GPP TS 27.007 Section 5.5.
   */
  async characterSet(): Promise<string> {
    const result = await this.channel.execute('AT+CSCS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CSCS? returned no data', result.lines.join('\n'))
    }

    const match = CSCS_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CSCS? response', line)
    }

    const [, charset] = match
    if (charset === undefined) {
      throw new ParseError('AT+CSCS? missing charset value', line)
    }

    return charset
  }

  /**
   * Set the TE character set via AT+CSCS="<charset>".
   *
   * Ref: 3GPP TS 27.007 Section 5.5.
   */
  async setCharacterSet(charset: string): Promise<void> {
    await this.channel.execute(`AT+CSCS="${charset}"`)
  }

  // ── AT+CCLK (Section 8.15) ──────────────────────────────────────────────

  /**
   * Read the modem real-time clock via AT+CCLK?
   *
   * Response format: +CCLK: "yy/MM/dd,hh:mm:ss±zz"
   * The timezone (±zz, in quarter-hours) is optional.
   *
   * Ref: 3GPP TS 27.007 Section 8.15.
   */
  async clock(): Promise<ClockInfo> {
    const result = await this.channel.execute('AT+CCLK?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CCLK? returned no data', result.lines.join('\n'))
    }

    const match = CCLK_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CCLK? response', line)
    }

    const [, yearStr, monthStr, dayStr, hourStr, minStr, secStr, tzStr] = match
    if (
      yearStr === undefined ||
      monthStr === undefined ||
      dayStr === undefined ||
      hourStr === undefined ||
      minStr === undefined ||
      secStr === undefined
    ) {
      throw new ParseError('AT+CCLK? missing date/time fields', line)
    }

    // Year: 2-digit -> 2000+yy, 4-digit -> as-is
    const rawYear = Number.parseInt(yearStr, 10)
    const year = rawYear < 100 ? 2000 + rawYear : rawYear

    const month = Number.parseInt(monthStr, 10)
    const day = Number.parseInt(dayStr, 10)
    const hour = Number.parseInt(hourStr, 10)
    const minute = Number.parseInt(minStr, 10)
    const second = Number.parseInt(secStr, 10)

    // Parse optional timezone offset (AT uses quarter-hours, we expose minutes)
    let timezoneOffsetMinutes: number | undefined
    if (tzStr !== undefined) {
      const quarterHours = Number.parseInt(tzStr, 10)
      timezoneOffsetMinutes = quarterHours * 15
    }

    // Build Date object. If timezone is present, interpret as local time with
    // the given offset. Otherwise, treat as UTC (no way to know the offset).
    let dateTime: Date
    if (timezoneOffsetMinutes !== undefined) {
      const utcMs =
        Date.UTC(year, month - 1, day, hour, minute, second) - timezoneOffsetMinutes * 60_000
      dateTime = new Date(utcMs)
    } else {
      dateTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    }

    return timezoneOffsetMinutes !== undefined ? { dateTime, timezoneOffsetMinutes } : { dateTime }
  }

  /** Set the modem real-time clock. */
  async setClock(dateTime: Date, timezoneOffsetMinutes?: number): Promise<void> {
    const yy = String(dateTime.getUTCFullYear() % 100).padStart(2, '0')
    const mm = String(dateTime.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(dateTime.getUTCDate()).padStart(2, '0')
    const hh = String(dateTime.getUTCHours()).padStart(2, '0')
    const min = String(dateTime.getUTCMinutes()).padStart(2, '0')
    const ss = String(dateTime.getUTCSeconds()).padStart(2, '0')

    let timeStr = `${yy}/${mm}/${dd},${hh}:${min}:${ss}`
    if (timezoneOffsetMinutes !== undefined) {
      // Convert minutes to AT protocol quarter-hours
      const quarterHours = Math.round(timezoneOffsetMinutes / 15)
      const sign = quarterHours >= 0 ? '+' : '-'
      const absOffset = String(Math.abs(quarterHours)).padStart(2, '0')
      timeStr += `${sign}${absOffset}`
    }

    await this.channel.execute(`AT+CCLK="${timeStr}"`)
  }

  // ── AT+CTZU (Section 8.40) ──────────────────────────────────────────────

  /**
   * Enable or disable automatic time zone update from the network (NITZ).
   *
   * Ref: 3GPP TS 27.007 Section 8.40.
   */
  async setAutoTimezone(enabled: boolean): Promise<void> {
    await this.channel.execute(`AT+CTZU=${enabled ? 1 : 0}`)
  }

  // ── Indicators ───────────────────────────────────────────────────────────

  /**
   * Read current modem indicator values.
   *
   * Lazily queries AT+CIND=? to learn available indicators, then
   * reads AT+CIND? for current values. Indicator names and ranges
   * are device-specific.
   */
  async indicators(): Promise<IndicatorReport> {
    const descriptors = await this.ensureIndicatorDescriptors()
    const result = await this.channel.execute('AT+CIND?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CIND? returned no data', result.lines.join('\n'))
    }

    const match = CIND_VALUES_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CIND? response', line)
    }

    const [, valuesStr] = match
    if (valuesStr === undefined) {
      throw new ParseError('AT+CIND? missing values', line)
    }

    const rawValues = valuesStr.split(',').map((s) => Number.parseInt(s.trim(), 10))
    const values: Record<string, number> = {}
    for (let i = 0; i < descriptors.length && i < rawValues.length; i++) {
      const descriptor = descriptors[i]
      const value = rawValues[i]
      if (descriptor !== undefined && value !== undefined) {
        values[descriptor.name] = value
      }
    }

    return { descriptors, values }
  }

  /**
   * Resolve a 1-based indicator index to its name.
   * Used by CIEV URC handler in AtAdapter.
   */
  resolveIndicatorName(index: number): string | undefined {
    const descriptor = this._indicatorDescriptors?.[index - 1]
    return descriptor?.name
  }

  // ── AT+CBC (Section 8.4) ───────────────────────────────────────────────

  /**
   * Read battery charge status and level via AT+CBC.
   *
   * Response format: +CBC: <bcs>,<bcl>
   *
   * Ref: 3GPP TS 27.007 Section 8.4.
   */
  async battery(): Promise<BatteryInfo> {
    const result = await this.channel.execute('AT+CBC')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CBC returned no data', result.lines.join('\n'))
    }

    const match = CBC_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CBC response', line)
    }

    const [, bcsStr, bclStr] = match
    if (bcsStr === undefined || bclStr === undefined) {
      throw new ParseError('AT+CBC missing fields', line)
    }

    const bcsCode = Number.parseInt(bcsStr, 10)
    const status = parseBatteryStatusCode(bcsCode)
    if (status === undefined) {
      throw new ParseError(`Unknown battery status code: ${bcsCode}`, line)
    }

    const chargeLevel = Number.parseInt(bclStr, 10)
    return { status, chargeLevel }
  }

  /** Lazily fetch and cache indicator descriptors from AT+CIND=? */
  private async ensureIndicatorDescriptors(): Promise<IndicatorDescriptor[]> {
    if (this._indicatorDescriptors !== undefined) {
      return this._indicatorDescriptors
    }

    const result = await this.channel.execute('AT+CIND=?')
    const raw = result.lines.join('')
    const descriptors: IndicatorDescriptor[] = []

    for (const match of raw.matchAll(CIND_DESCRIPTOR_REGEX)) {
      const [, name, minStr, maxStr] = match
      if (name === undefined || minStr === undefined || maxStr === undefined) continue
      descriptors.push({
        name,
        min: Number.parseInt(minStr, 10),
        max: Number.parseInt(maxStr, 10),
      })
    }

    this._indicatorDescriptors = descriptors
    return descriptors
  }
}
