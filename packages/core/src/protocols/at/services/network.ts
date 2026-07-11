import { ParseError } from '../../../errors.js'
import type {
  AvailableNetwork,
  OperatorNameEntry,
  PreferredOperator,
  RegistrationInfo,
  SignalInfo,
} from '../../../types.js'
import type { Network } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// 3GPP TS 27.007 section 7.2 -- registration status codes
export const REGISTRATION_STATUS: Record<number, RegistrationInfo['status']> = {
  0: 'notRegistered',
  1: 'home',
  2: 'searching',
  3: 'denied',
  4: 'unknown',
  5: 'roaming',
}

// 3GPP TS 27.007 section 7.2 -- Access Technology codes (user-friendly labels)
export const ACCESS_TECHNOLOGY: Record<number, string> = {
  0: 'GSM',
  1: 'GSM Compact',
  2: '3G',
  3: 'EDGE',
  4: '3G HSDPA',
  5: '3G HSUPA',
  6: '3G HSPA+',
  7: 'LTE',
  11: 'LTE+NR',
  12: '5G',
  13: '5G',
}

// ── AT+CSQ ──────────────────────────────────────────────────────────────────
// 3GPP TS 27.007 section 8.5

const CSQ_UNKNOWN = 99 // Not known or not detectable
const RSSI_BASE_DBM = -113 // Minimum detectable signal
const RSSI_STEP_DBM = 2 // Each CSQ unit = 2 dBm

// ── AT+CESQ ─────────────────────────────────────────────────────────────────
// 3GPP TS 27.007 section 8.69 -- Extended signal quality
//
// +CESQ: <rxlev>,<ber>,<rscp>,<ecno>,<rsrq>,<rsrp>
// Technology-specific fields are set to sentinel when not active.

const CESQ_REGEX = /\+CESQ:\s*(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/

// Sentinel values for "not known or not detectable"
const CESQ_RXLEV_UNKNOWN = 99
const CESQ_UTRA_UNKNOWN = 255 // rscp, ecno
const CESQ_LTE_UNKNOWN = 255 // rsrq, rsrp

// Conversion formulas per 3GPP TS 27.007 section 8.69
const RXLEV_BASE_DBM = -110 // rxlev 0 = < -110 dBm
const RSCP_BASE_DBM = -120 // rscp 0 = < -120 dBm
const ECNO_BASE_DB = -24 // ecno 0 = < -24 dB, step 0.5 dB
const RSRQ_BASE_DB = -19.5 // rsrq 0 = < -19.5 dB, step 0.5 dB
const RSRP_BASE_DBM = -140 // rsrp 0 = < -140 dBm
const ECNO_STEP_DB = 0.5
const RSRQ_STEP_DB = 0.5

// ── Registration ────────────────────────────────────────────────────────────

// +CREG: <n>,<stat>[,"<lac>","<ci>"[,<AcT>]]
const CREG_REGEX = /\+CREG:\s*\d+,(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?/

// +CGREG: <n>,<stat>[,"<lac>","<ci>"[,<AcT>]]
// Same format as CREG, different prefix. GPRS/PS domain registration.
const CGREG_REGEX = /\+CGREG:\s*\d+,(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?/

// +CEREG: <n>,<stat>[,"<tac>","<ci>"[,<AcT>]]
// Same format as CREG, different prefix. TAC occupies the same field as LAC.
const CEREG_REGEX = /\+CEREG:\s*\d+,(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?/

// ── Operator ────────────────────────────────────────────────────────────────

// +COPS: <mode>[,<format>,"<oper>"[,<AcT>]]
const COPS_REGEX = /\+COPS:\s*\d+(?:,\d+,"([^"]*)"(?:,(\d+))?)?/

// AT+COPS=? response: (status,"longName","shortName","numeric"[,AcT])
const COPS_SCAN_ENTRY = /\((\d+),"([^"]*)","([^"]*)","(\d+)"(?:,(\d+))?\)/g

// 3GPP TS 27.007 section 7.13 -- operator status codes
const COPS_STATUS: Record<number, AvailableNetwork['status']> = {
  0: 'unknown',
  1: 'available',
  2: 'current',
  3: 'forbidden',
}

// AT+COPN response: +COPN: "<numeric>","<alpha>"
const COPN_REGEX = /\+COPN:\s*"(\d+)","([^"]*)"/

// ── Preferred Operators ─────────────────────────────────────────────────────
// 3GPP TS 27.007 section 7.19 -- AT+CPOL
//
// +CPOL: <index>,<format>,"<oper>",<GSM_AcT>,<GSM_Compact_AcT>,<UTRAN_AcT>,<E-UTRAN_AcT>[,<NR_AcT>]

const CPOL_REGEX = /\+CPOL:\s*(\d+),(\d+),"([^"]+)",(\d+),(\d+),(\d+),(\d+)(?:,(\d+))?/

/** Network registration, signal, and operator information */
export class NetworkModule implements Network {
  private readonly channel: ATChannel
  private readonly profile: AtConfig

  constructor(channel: ATChannel, profile: AtConfig) {
    this.channel = channel
    this.profile = profile
  }

  // ── Signal ──────────────────────────────────────────────────────────────

  /**
   * Query current signal strength.
   *
   * Layered approach:
   * 1. AT+CSQ (base) -- always available, RSSI + BER
   * 2. Vendor signal command (if configured) -- RSRP/RSRQ/SINR/band/technology
   * 3. AT+CESQ (fallback) -- standard 3GPP extended metrics when no vendor signal
   *
   * Vendor signal takes priority over CESQ because vendor commands typically
   * provide richer data (SINR, band) that CESQ doesn't.
   */
  async signal(): Promise<SignalInfo> {
    const base = await this.standardSignal()

    // Vendor-specific enhanced signal (e.g. Huawei AT^HCSQ?)
    const signalConfig = this.profile.signal
    if (signalConfig !== undefined) {
      try {
        const result = await this.channel.execute(signalConfig.command)
        const enhanced = signalConfig.parse(result.lines)
        return { ...base, ...enhanced }
      } catch {
        // Vendor command failed -- fall through to standard CESQ
      }
    }

    // Standard AT+CESQ for technology-specific metrics (RSRP, RSRQ, RSCP, Ec/No)
    const cesq = await this.cesqSignal()
    return cesq !== undefined ? { ...base, ...cesq } : base
  }

  /** Standard AT+CSQ: RSSI (dBm) + BER */
  private async standardSignal(): Promise<SignalInfo> {
    const result = await this.channel.execute('AT+CSQ')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CSQ returned no data', result.lines.join('\n'))
    }

    const match = /\+CSQ:\s*(\d+),(\d+)/.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CSQ response', line)
    }

    const [, rawRssiStr, berStr] = match
    if (rawRssiStr === undefined || berStr === undefined) {
      throw new ParseError('Incomplete AT+CSQ response', line)
    }

    const rawRssi = Number.parseInt(rawRssiStr, 10)
    const bitErrorRate = Number.parseInt(berStr, 10)

    // Convert 0-31 scale to dBm: dBm = -113 + (rssi * 2)
    // CSQ 99 = "not known or not detectable" per 3GPP TS 27.007 -- honest undefined
    const rssi = rawRssi === CSQ_UNKNOWN ? undefined : RSSI_BASE_DBM + rawRssi * RSSI_STEP_DBM

    return { rssi, bitErrorRate }
  }

  /**
   * Extended signal quality via AT+CESQ (3GPP TS 27.007 Section 8.69).
   *
   * Returns technology-specific metrics: RSRP/RSRQ for LTE, RSCP/Ec/No for WCDMA,
   * refined RSSI for GSM. Technology is inferred from which fields are valid.
   *
   * Returns undefined when AT+CESQ is not supported or returns all unknowns.
   */
  private async cesqSignal(): Promise<Partial<SignalInfo> | undefined> {
    try {
      const result = await this.channel.execute('AT+CESQ')
      const line = result.lines[0]
      if (line === undefined) return undefined

      const match = CESQ_REGEX.exec(line)
      if (match === null) return undefined

      const [, rxlevStr, , rscpStr, ecnoStr, rsrqStr, rsrpStr] = match
      if (
        rxlevStr === undefined ||
        rscpStr === undefined ||
        ecnoStr === undefined ||
        rsrqStr === undefined ||
        rsrpStr === undefined
      ) {
        return undefined
      }

      const rxlev = Number.parseInt(rxlevStr, 10)
      const rscp = Number.parseInt(rscpStr, 10)
      const ecno = Number.parseInt(ecnoStr, 10)
      const rsrq = Number.parseInt(rsrqStr, 10)
      const rsrp = Number.parseInt(rsrpStr, 10)

      // Technology is inferred from which fields carry valid (non-sentinel) data.
      // Only one technology's fields are valid at a time per 3GPP.

      if (rsrp !== CESQ_LTE_UNKNOWN) {
        return {
          technology: 'LTE',
          rsrp: RSRP_BASE_DBM + rsrp,
          rsrq: rsrq !== CESQ_LTE_UNKNOWN ? RSRQ_BASE_DB + rsrq * RSRQ_STEP_DB : undefined,
        }
      }

      if (rscp !== CESQ_UTRA_UNKNOWN) {
        return {
          technology: '3G',
          rscp: RSCP_BASE_DBM + rscp,
          ecno: ecno !== CESQ_UTRA_UNKNOWN ? ECNO_BASE_DB + ecno * ECNO_STEP_DB : undefined,
        }
      }

      if (rxlev !== CESQ_RXLEV_UNKNOWN) {
        // GSM: rxlev has finer granularity than CSQ (0-63 vs 0-31)
        return {
          technology: 'GSM',
          rssi: RXLEV_BASE_DBM + rxlev,
        }
      }

      return undefined
    } catch {
      // AT+CESQ not supported by this modem
      return undefined
    }
  }

  // ── Registration ────────────────────────────────────────────────────────

  /** Query CS (circuit-switched) registration status via AT+CREG. */
  async registration(): Promise<RegistrationInfo> {
    const result = await this.channel.execute('AT+CREG?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CREG? returned no data', result.lines.join('\n'))
    }

    const info = parseRegistrationLine(line, CREG_REGEX, 'AT+CREG?')

    // E3372 omits AcT from +CREG? -- fall back to +COPS? which always includes it
    if (info.technology === undefined) {
      const copsAcT = await this.technologyFromCops()
      return { ...info, technology: copsAcT }
    }

    return info
  }

  /**
   * EPS/LTE registration status via AT+CEREG.
   *
   * Same shape as registration() but for the EPS domain.
   * The locationAreaCode field contains the TAC (tracking area code).
   *
   * Ref: 3GPP TS 27.007 Section 10.1.22.
   */
  async epsRegistration(): Promise<RegistrationInfo> {
    const result = await this.channel.execute('AT+CEREG?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CEREG? returned no data', result.lines.join('\n'))
    }

    return parseRegistrationLine(line, CEREG_REGEX, 'AT+CEREG?')
  }

  /**
   * GPRS/PS registration status via AT+CGREG.
   *
   * Same shape as registration() but for the GPRS/PS domain.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.20.
   */
  async gprsRegistration(): Promise<RegistrationInfo> {
    const result = await this.channel.execute('AT+CGREG?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CGREG? returned no data', result.lines.join('\n'))
    }

    return parseRegistrationLine(line, CGREG_REGEX, 'AT+CGREG?')
  }

  /** Extract AcT from +COPS? as fallback when +CREG? omits it. */
  private async technologyFromCops(): Promise<string | undefined> {
    try {
      const result = await this.channel.execute('AT+COPS?')
      const line = result.lines[0]
      if (line === undefined) return undefined
      const match = COPS_REGEX.exec(line)
      if (match === null) return undefined
      const [, , actStr] = match
      if (actStr === undefined) return undefined
      return ACCESS_TECHNOLOGY[Number.parseInt(actStr, 10)]
    } catch {
      return undefined
    }
  }

  // ── Operator ────────────────────────────────────────────────────────────

  /** Query current operator name. Returns undefined when not registered. */
  async operator(): Promise<string | undefined> {
    // Request long alphanumeric format (0) without changing selection mode.
    // Some modems default to numeric format (2), which returns PLMN codes
    // like "28310" instead of "Ucom". AT+COPS=3,<format> sets the format
    // for subsequent AT+COPS? queries per 3GPP TS 27.007 section 7.3.
    await this.channel.execute('AT+COPS=3,0')

    const result = await this.channel.execute('AT+COPS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+COPS? returned no data', result.lines.join('\n'))
    }

    const match = COPS_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+COPS? response', line)
    }

    // oper is undefined when not registered (e.g. "+COPS: 0") -- legitimate absence
    const [, oper] = match
    return oper
  }

  /** Scan for available networks. Slow: typically 30-120 seconds. */
  async scan(): Promise<AvailableNetwork[]> {
    const result = await this.channel.execute('AT+COPS=?')
    const raw = result.lines.join('')
    const networks: AvailableNetwork[] = []

    for (const match of raw.matchAll(COPS_SCAN_ENTRY)) {
      const [, statStr, name, shortName, numeric, actStr] = match
      if (
        statStr === undefined ||
        name === undefined ||
        shortName === undefined ||
        numeric === undefined
      ) {
        continue
      }

      const statCode = Number.parseInt(statStr, 10)
      const status = COPS_STATUS[statCode] ?? 'unknown'
      const technology =
        actStr !== undefined ? ACCESS_TECHNOLOGY[Number.parseInt(actStr, 10)] : undefined

      networks.push({ status, name, shortName, numeric, technology })
    }

    return networks
  }

  /** Manually select a network by PLMN code. */
  async selectOperator(plmn: string): Promise<void> {
    // mode=1 (manual), format=2 (numeric)
    await this.channel.execute(`AT+COPS=1,2,"${plmn}"`)
  }

  /** Return to automatic network selection. */
  async selectAutomatic(): Promise<void> {
    await this.channel.execute('AT+COPS=0')
  }

  /**
   * Read operator name database from modem firmware (AT+COPN).
   *
   * Dumps all stored numeric-to-name mappings. The list comes from firmware
   * memory, not the SIM card. Can return hundreds of entries.
   *
   * Ref: 3GPP TS 27.007 Section 7.21.
   */
  async operatorNames(): Promise<OperatorNameEntry[]> {
    const result = await this.channel.execute('AT+COPN')
    const entries: OperatorNameEntry[] = []

    for (const line of result.lines) {
      const match = COPN_REGEX.exec(line)
      if (match === null) continue
      const [, numeric, name] = match
      if (numeric === undefined || name === undefined) continue
      entries.push({ numeric, name })
    }

    return entries
  }

  // ── Preferred Operators ─────────────────────────────────────────────────

  /**
   * Read preferred operator list from SIM (AT+CPOL).
   *
   * Returns entries with PLMN codes and preferred access technologies.
   * Uses numeric format (2) for consistent PLMN codes.
   *
   * Ref: 3GPP TS 27.007 Section 7.19.
   */
  async preferredOperators(): Promise<PreferredOperator[]> {
    // Set format to numeric so we get MCC+MNC codes
    await this.channel.execute('AT+CPOL=,2')

    const result = await this.channel.execute('AT+CPOL?')
    const operators: PreferredOperator[] = []

    for (const line of result.lines) {
      const match = CPOL_REGEX.exec(line)
      if (match === null) continue

      const [, indexStr, , numeric, gsmStr, , utranStr, eutranStr, nrStr] = match
      if (
        indexStr === undefined ||
        numeric === undefined ||
        gsmStr === undefined ||
        utranStr === undefined ||
        eutranStr === undefined
      ) {
        continue
      }

      operators.push({
        index: Number.parseInt(indexStr, 10),
        numeric,
        gsm: gsmStr === '1',
        utran: utranStr === '1',
        eutran: eutranStr === '1',
        nr: nrStr !== undefined ? nrStr === '1' : undefined,
      })
    }

    return operators
  }

  /**
   * Add or update a preferred operator entry on the SIM.
   *
   * Ref: 3GPP TS 27.007 Section 7.19.
   */
  async setPreferredOperator(entry: {
    readonly index: number
    readonly numeric: string
    readonly gsm?: boolean
    readonly utran?: boolean
    readonly eutran?: boolean
  }): Promise<void> {
    const gsm = entry.gsm === true ? 1 : 0
    const utran = entry.utran === true ? 1 : 0
    const eutran = entry.eutran === true ? 1 : 0
    // format=2 (numeric), GSM_Compact always 0 (deprecated per 3GPP)
    await this.channel.execute(
      `AT+CPOL=${entry.index},2,"${entry.numeric}",${gsm},0,${utran},${eutran}`,
    )
  }

  /** Delete a preferred operator entry by index. */
  async removePreferredOperator(index: number): Promise<void> {
    await this.channel.execute(`AT+CPOL=${index}`)
  }
}

// ── Shared Registration Parser ────────────────────────────────────────────

/**
 * Parse a +CREG or +CEREG response line into RegistrationInfo.
 *
 * Both commands share the same response format:
 *   +<PREFIX>: <n>,<stat>[,"<lac/tac>","<ci>"[,<AcT>]]
 *
 * The locationAreaCode field contains LAC for CREG or TAC for CEREG.
 */
function parseRegistrationLine(line: string, regex: RegExp, commandName: string): RegistrationInfo {
  const match = regex.exec(line)
  if (match === null) {
    throw new ParseError(`Failed to parse ${commandName} response`, line)
  }

  const [, statStr, locationAreaCode, cellId, actStr] = match
  if (statStr === undefined) {
    throw new ParseError(`${commandName} missing status code`, line)
  }

  const statCode = Number.parseInt(statStr, 10)
  const status = REGISTRATION_STATUS[statCode] ?? 'unknown'
  const technology =
    actStr !== undefined ? ACCESS_TECHNOLOGY[Number.parseInt(actStr, 10)] : undefined

  if (locationAreaCode !== undefined && locationAreaCode !== '') {
    return {
      status,
      locationAreaCode,
      // Cell ID all-zeros = modem hasn't decoded the cell identity yet
      cellId: cellId !== undefined && cellId !== '' && !/^0+$/.test(cellId) ? cellId : undefined,
      technology,
    }
  }

  return { status, technology }
}
