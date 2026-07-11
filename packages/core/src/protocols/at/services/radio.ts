import { ParseError } from '../../../errors.js'
import type {
  EDrxAccessType,
  EDrxConfig,
  EDrxDynamicParams,
  ExtendedErrorReport,
  FunctionalityMode,
  PhoneActivityStatus,
  PsmConfig,
  SignallingConnectionStatus,
  WirelessServiceMode,
} from '../../../types.js'
import type { Radio } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import {
  decodeEdrxCycle,
  decodeGprsTimer,
  decodeGprsTimer3,
  decodePagingWindow,
  encodeEdrxCycle,
  encodeGprsTimer,
  encodeGprsTimer3,
} from './timer-encoding.js'

// +CFUN: <fun>
const CFUN_REGEX = /\+CFUN:\s*(\d+)/

// <fun> value -> FunctionalityMode
const CFUN_MODE_MAP: Record<number, FunctionalityMode> = {
  0: 'minimum',
  1: 'full',
  2: 'txDisabled',
  3: 'rxDisabled',
  4: 'airplane',
  129: 'shutdown',
}

// FunctionalityMode -> <fun> value
const MODE_TO_CFUN: Record<FunctionalityMode, number> = {
  minimum: 0,
  full: 1,
  txDisabled: 2,
  rxDisabled: 3,
  airplane: 4,
  shutdown: 129,
}

// +CEER: <report>
const CEER_REGEX = /\+CEER:\s*(.+)/

// +CPAS: <pas>
const CPAS_REGEX = /\+CPAS:\s*(\d+)/

const CPAS_STATUS_MAP: Record<number, PhoneActivityStatus> = {
  0: 'ready',
  1: 'unavailable',
  2: 'unknown',
  3: 'ringing',
  4: 'callInProgress',
  5: 'asleep',
}

// +WS46: <n>
const WS46_REGEX = /\+WS46:\s*(\d+)/

// WS46 numeric code -> semantic mode
const WS46_TO_MODE: Record<number, WirelessServiceMode> = {
  12: 'gsm',
  22: 'utran',
  25: 'auto',
  28: 'lte',
  29: 'gsmAndUtran',
  30: 'gsmAndLte',
  31: 'utranAndLte',
  35: 'autoWith5g',
  36: 'nrOnly',
}

// Semantic mode -> WS46 numeric code
const MODE_TO_WS46: Record<WirelessServiceMode, number> = {
  gsm: 12,
  utran: 22,
  auto: 25,
  lte: 28,
  gsmAndUtran: 29,
  gsmAndLte: 30,
  utranAndLte: 31,
  autoWith5g: 35,
  nrOnly: 36,
}

// ── PSM ──────────────────────────────────────────────────────────────────────

// +CPSMS: <mode>[,"<Periodic-RAU>","<GPRS-READY>","<Periodic-TAU>","<Active-Time>"]
const CPSMS_REGEX = /\+CPSMS:\s*(\d)(?:,("?[01]*"?)?,("?[01]*"?)?,("?[01]*"?)?,("?[01]*"?)?)?/

/** Strip optional quotes from a timer value string */
function unquoteTimer(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '' || raw === '""') return undefined
  return raw.replace(/^"|"$/g, '') || undefined
}

// ── eDRX ─────────────────────────────────────────────────────────────────────

// +CEDRXS: <AcT-type>,"<Requested_eDRX_value>"
const CEDRXS_LINE_REGEX = /\+CEDRXS:\s*(\d+),"([01]+)"/

// +CEDRXRDP: <AcT-type>[,"<requested>"[,"<nw-provided>"[,"<paging-window>"]]]
const CEDRXRDP_REGEX = /\+CEDRXRDP:\s*(\d+)(?:,"([01]*)"(?:,"([01]*)"(?:,"([01]*)")?)?)?/

// Numeric code -> EDrxAccessType
const EDRX_ACT_MAP: Record<number, EDrxAccessType> = {
  0: 'none',
  1: 'ecGsmIot',
  2: 'gsm',
  3: 'utran',
  4: 'eutranWb',
  5: 'eutranNb',
}

// EDrxAccessType -> numeric code
const ACT_TO_EDRX: Record<EDrxAccessType, number> = {
  none: 0,
  ecGsmIot: 1,
  gsm: 2,
  utran: 3,
  eutranWb: 4,
  eutranNb: 5,
}

// ── CSCON ────────────────────────────────────────────────────────────────────

// +CSCON: <n>,<mode>[,<state>]  (read response has <n> prefix)
const CSCON_READ_REGEX = /\+CSCON:\s*\d+,(\d+)(?:,(\d+))?/

/**
 * Radio power control, activity status, and error diagnostics.
 */
export class RadioModule implements Radio {
  constructor(private readonly channel: ATChannel) {}

  /** Query current functionality mode */
  async functionality(): Promise<FunctionalityMode> {
    const result = await this.channel.execute('AT+CFUN?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CFUN? returned no data', result.lines.join('\n'))
    }

    const match = CFUN_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CFUN? response', line)
    }

    const [, funStr] = match
    if (funStr === undefined) {
      throw new ParseError('AT+CFUN? missing functionality code', line)
    }

    const funCode = Number.parseInt(funStr, 10)
    const mode = CFUN_MODE_MAP[funCode]
    if (mode === undefined) {
      // Manufacturer-specific intermediate state (5-127)
      throw new ParseError(`Unknown CFUN mode ${funCode}`, line)
    }

    return mode
  }

  /**
   * Set phone functionality level.
   *
   * The reset parameter is only valid with 'full' mode.
   */
  async setFunctionality(mode: FunctionalityMode, reset?: boolean): Promise<void> {
    const funCode = MODE_TO_CFUN[mode]
    const rstParam = reset === true ? ',1' : ''
    await this.channel.execute(`AT+CFUN=${funCode}${rstParam}`)
  }

  /**
   * Extended error report for last failed operation.
   *
   * Returns the cause of the last failed call/connection/attach/activation.
   * The report format is manufacturer-determined.
   */
  async lastError(): Promise<ExtendedErrorReport> {
    const result = await this.channel.execute('AT+CEER')
    const line = result.lines[0]
    if (line === undefined) {
      return { report: 'No report available' }
    }

    const match = CEER_REGEX.exec(line)
    if (match === null) {
      return { report: line.trim() }
    }

    const [, report] = match
    if (report === undefined) {
      return { report: 'No report available' }
    }

    return { report: report.trim() }
  }

  // ── Activity Status ───────────────────────────────────────────────────

  /** Query phone activity status */
  async activityStatus(): Promise<PhoneActivityStatus> {
    const result = await this.channel.execute('AT+CPAS')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CPAS returned no data', result.lines.join('\n'))
    }

    const match = CPAS_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CPAS response', line)
    }

    const [, pasStr] = match
    if (pasStr === undefined) {
      throw new ParseError('AT+CPAS missing status code', line)
    }

    const pasCode = Number.parseInt(pasStr, 10)
    const status = CPAS_STATUS_MAP[pasCode]
    if (status === undefined) {
      throw new ParseError(`Unknown CPAS status ${pasCode}`, line)
    }

    return status
  }

  // ── Wireless Service Selection ────────────────────────────────────────

  /** Query current wireless data service mode */
  async wirelessService(): Promise<WirelessServiceMode> {
    const result = await this.channel.execute('AT+WS46?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+WS46? returned no data', result.lines.join('\n'))
    }

    const match = WS46_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+WS46? response', line)
    }

    const [, valueStr] = match
    if (valueStr === undefined) {
      throw new ParseError('AT+WS46? missing value', line)
    }

    const code = Number.parseInt(valueStr, 10)
    const mode = WS46_TO_MODE[code]
    if (mode === undefined) {
      throw new ParseError(`Unknown WS46 code ${code}`, line)
    }

    return mode
  }

  /** Set wireless data service mode */
  async setWirelessService(mode: WirelessServiceMode): Promise<void> {
    const code = MODE_TO_WS46[mode]
    await this.channel.execute(`AT+WS46=${code}`)
  }

  // ── Power Saving Mode ──────────────────────────────────────────────────

  /** Query PSM configuration */
  async powerSavingMode(): Promise<PsmConfig> {
    const result = await this.channel.execute('AT+CPSMS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CPSMS? returned no data', result.lines.join('\n'))
    }

    const match = CPSMS_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CPSMS? response', line)
    }

    const [, modeStr, rauRaw, , tauRaw, activeRaw] = match
    if (modeStr === undefined) {
      throw new ParseError('AT+CPSMS? missing mode', line)
    }

    // Decode wire-format binary timer strings to seconds.
    // Prefer TAU (LTE periodic update) for sleep; fall back to RAU (2G/3G).
    const tauBinary = unquoteTimer(tauRaw)
    const rauBinary = unquoteTimer(rauRaw)
    const activeBinary = unquoteTimer(activeRaw)

    let sleepDurationSeconds: number | undefined
    if (tauBinary !== undefined) {
      sleepDurationSeconds = decodeGprsTimer3(tauBinary)
    } else if (rauBinary !== undefined) {
      sleepDurationSeconds = decodeGprsTimer(rauBinary)
    }

    return {
      enabled: modeStr === '1',
      sleepDurationSeconds,
      activeDurationSeconds: activeBinary !== undefined ? decodeGprsTimer(activeBinary) : undefined,
    }
  }

  /** Set PSM configuration */
  async setPowerSavingMode(config: PsmConfig): Promise<void> {
    const mode = config.enabled ? 1 : 0
    // RAU and GPRS-READY are 2G/3G-specific; leave empty for LTE dongles
    const rau = ','
    const ready = ','
    const tau =
      config.sleepDurationSeconds !== undefined
        ? `,"${encodeGprsTimer3(config.sleepDurationSeconds)}"`
        : ','
    const active =
      config.activeDurationSeconds !== undefined
        ? `,"${encodeGprsTimer(config.activeDurationSeconds)}"`
        : ''
    await this.channel.execute(`AT+CPSMS=${mode}${rau}${ready}${tau}${active}`)
  }

  /** Disable PSM and reset all timer parameters to defaults */
  async resetPowerSavingMode(): Promise<void> {
    await this.channel.execute('AT+CPSMS=2')
  }

  // ── eDRX ───────────────────────────────────────────────────────────────

  /** Query eDRX settings for all configured access technologies */
  async edrxSettings(): Promise<EDrxConfig[]> {
    const result = await this.channel.execute('AT+CEDRXS?')
    const configs: EDrxConfig[] = []

    for (const line of result.lines) {
      const match = CEDRXS_LINE_REGEX.exec(line)
      if (match === null) continue
      const [, actStr, value] = match
      if (actStr === undefined || value === undefined) continue
      const accessType = EDRX_ACT_MAP[Number.parseInt(actStr, 10)]
      if (accessType === undefined) continue
      const cycleDurationSeconds = decodeEdrxCycle(value, accessType)
      if (cycleDurationSeconds === undefined) continue
      configs.push({ accessType, cycleDurationSeconds })
    }

    return configs
  }

  /** Set eDRX for a specific access technology */
  async setEdrx(accessType: EDrxAccessType, cycleDurationSeconds: number): Promise<void> {
    const actCode = ACT_TO_EDRX[accessType]
    const binaryCode = encodeEdrxCycle(cycleDurationSeconds, accessType)
    await this.channel.execute(`AT+CEDRXS=2,${actCode},"${binaryCode}"`)
  }

  /** Disable eDRX globally */
  async disableEdrx(): Promise<void> {
    await this.channel.execute('AT+CEDRXS=0')
  }

  /** Disable eDRX and reset all parameters to defaults */
  async resetEdrx(): Promise<void> {
    await this.channel.execute('AT+CEDRXS=3')
  }

  /** Read eDRX dynamic parameters from the registered cell */
  async edrxDynamicParams(): Promise<EDrxDynamicParams> {
    const result = await this.channel.execute('AT+CEDRXRDP')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CEDRXRDP returned no data', result.lines.join('\n'))
    }

    const match = CEDRXRDP_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CEDRXRDP response', line)
    }

    const [, actStr, requested, network, paging] = match
    if (actStr === undefined) {
      throw new ParseError('AT+CEDRXRDP missing access type', line)
    }

    const accessType = EDRX_ACT_MAP[Number.parseInt(actStr, 10)]
    if (accessType === undefined) {
      throw new ParseError(`Unknown eDRX access type ${actStr}`, line)
    }

    return {
      accessType,
      requestedCycleSeconds:
        requested !== undefined && requested !== ''
          ? decodeEdrxCycle(requested, accessType)
          : undefined,
      networkCycleSeconds:
        network !== undefined && network !== '' ? decodeEdrxCycle(network, accessType) : undefined,
      pagingWindowSeconds:
        paging !== undefined && paging !== '' ? decodePagingWindow(paging, accessType) : undefined,
    }
  }

  // ── Signalling Connection ──────────────────────────────────────────────

  /** Query RRC signalling connection status */
  async signallingConnection(): Promise<SignallingConnectionStatus> {
    const result = await this.channel.execute('AT+CSCON?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CSCON? returned no data', result.lines.join('\n'))
    }

    const match = CSCON_READ_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CSCON? response', line)
    }

    const [, modeStr] = match
    if (modeStr === undefined) {
      throw new ParseError('AT+CSCON? missing mode', line)
    }

    const modeCode = Number.parseInt(modeStr, 10)

    return {
      mode: modeCode === 0 ? 'idle' : 'connected',
    }
  }
}
