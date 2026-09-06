import { ATError, ParseError } from '../../../errors.js'
import type { ModelInfo, PinRetryInfo, SimInfo } from '../../../types.js'
import type { Sim } from '../../adapter.js'
import { normalizeIccid } from '../../iccid.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// +CPIN response -> SimInfo state
const SIM_STATES: Record<string, SimInfo['state']> = {
  READY: 'ready',
  'SIM PIN': 'pinRequired',
  'SIM PUK': 'pukRequired',
  'PH-NET PIN': 'networkLocked', // network personalization lock (carrier lock)
}

// Matches any prefixed ICCID response: "+CCID: ...", "^ICCID: ...", "^SCID: ...",
// or a bare-word prefix like ZTE's "ICCID: ...". The leading +/^ is optional so
// letter-initial vendor prefixes are stripped too. A raw all-digit ICCID has no
// colon and falls through to the unprefixed path.
const ICCID_PREFIX_REGEX = /^[+^]?\w+:\s*(.+)$/
const CPIN_REGEX = /\+CPIN:\s*(.+)/
const COPS_OPER_REGEX = /\+COPS:\s*\d+(?:,\d+,"([^"]*)")?/
// +CNUM: [<alpha>],"<number>",<type>
const CNUM_REGEX = /,"([^"]+)"/

// 3GPP TS 27.007 Section 8.65 -- AT+CPINR
// +CPINR: <code>,<retries>[,<default_retries>]
// One line per code (SIM PIN, SIM PUK, SIM PIN2, SIM PUK2)
const CPINR_REGEX = /\+CPINR:\s*"?([^",]+)"?,(\d+)/

// 3GPP TS 27.007 Section 7.4 -- AT+CLCK
// +CLCK: <status>[,<class1>]
const CLCK_REGEX = /\+CLCK:\s*(\d+)/

// CME ERROR code 10 = SIM not inserted
const CME_SIM_NOT_INSERTED = 10

// AT+CPIN? should respond instantly. Some devices (E3372 stick mode)
// hang indefinitely when no SIM is inserted instead of returning
// CME ERROR 10. Short timeout catches this and treats it as absent.
const CPIN_TIMEOUT_MS = 3_000

/** SIM card information and management */
export class SimModule implements Sim {
  private readonly channel: ATChannel
  private readonly profile: AtConfig
  /**
   * Set by AtAdapter.init() when any init command returns CME ERROR 10
   * (SIM not inserted). Allows _queryState() to skip AT+CPIN? entirely
   * -- some devices (E3372) hang on CPIN when SIM is absent.
   */
  private _knownAbsent = false

  constructor(channel: ATChannel, profile: AtConfig, _model?: ModelInfo | undefined) {
    this.channel = channel
    this.profile = profile
  }

  /** Mark SIM as known absent (learned from init command errors). */
  markAbsent(): void {
    this._knownAbsent = true
  }

  /** Query SIM status, ICCID, IMSI, and operator */
  async info(): Promise<SimInfo> {
    // Step 1: Query SIM state via AT+CPIN?
    const state = await this._queryState()

    if (state === 'absent' || state === 'error') {
      return { iccid: undefined, state }
    }

    // Step 2: Query ICCID, IMSI, operator in parallel
    // Use allSettled because IMSI/operator may fail if PIN is required
    const [iccidResult, imsiResult, operResult] = await Promise.allSettled([
      this.iccid(),
      this.imsi(),
      this._queryOperator(),
    ])

    const iccid = iccidResult.status === 'fulfilled' ? iccidResult.value : undefined
    const imsi = imsiResult.status === 'fulfilled' ? imsiResult.value : undefined
    const operator = operResult.status === 'fulfilled' ? operResult.value : undefined

    return {
      iccid,
      state,
      imsi: imsi !== undefined && imsi !== '' ? imsi : undefined,
      operator: operator || undefined,
    }
  }

  /**
   * Query ICCID (SIM card serial number).
   *
   * Uses the profile's vendor-specific command if available,
   * otherwise falls back to the standard AT+CCID.
   *
   * Vendor profiles can override the ICCID command via `profile.commands.iccid`
   * (e.g. Huawei uses `AT^ICCID?` instead of standard `AT+CCID`).
   */
  async iccid(): Promise<string> {
    const vendorCmd = this.profile.commands?.iccid

    const cmd = vendorCmd ?? 'AT+CCID'
    const result = await this.channel.execute(cmd)
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError(`${cmd} returned no data`, result.lines.join('\n'))
    }

    // Parse "+CCID: <iccid>" or "^ICCID: <iccid>" or raw number
    const [, prefixed] = ICCID_PREFIX_REGEX.exec(line) ?? []
    const raw = (prefixed ?? line).trim()

    return normalizeIccid(raw)
  }

  /** Query IMSI */
  async imsi(): Promise<string> {
    const result = await this.channel.execute('AT+CIMI')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CIMI returned no data', result.lines.join('\n'))
    }
    return line
  }

  /** Enter SIM PIN */
  async enterPin(pin: string): Promise<void> {
    await this.channel.execute(`AT+CPIN="${pin}"`)
  }

  /** Query subscriber phone number (MSISDN) via AT+CNUM. */
  async phoneNumber(): Promise<string | undefined> {
    try {
      const result = await this.channel.execute('AT+CNUM')
      const line = result.lines[0]
      if (line === undefined) return undefined
      const [, number] = CNUM_REGEX.exec(line) ?? []
      return number
    } catch {
      return undefined
    }
  }

  /**
   * Query remaining PIN/PUK retry counts via AT+CPINR.
   *
   * Response format (one line per code):
   *   +CPINR: "SIM PIN",3
   *   +CPINR: "SIM PUK",10
   *   +CPINR: "SIM PIN2",3
   *   +CPINR: "SIM PUK2",10
   *
   * Ref: 3GPP TS 27.007 Section 8.65.
   */
  async pinRetries(): Promise<PinRetryInfo> {
    const result = await this.channel.execute('AT+CPINR')
    const retries: Record<string, number> = {}

    for (const line of result.lines) {
      const match = CPINR_REGEX.exec(line)
      if (match === null) continue
      const [, code, countStr] = match
      if (code === undefined || countStr === undefined) continue
      retries[code.trim().toUpperCase()] = Number.parseInt(countStr, 10)
    }

    const pin = retries['SIM PIN']
    const puk = retries['SIM PUK']
    if (pin === undefined || puk === undefined) {
      throw new ParseError('AT+CPINR missing PIN/PUK retry counts', result.lines.join('\n'))
    }

    return {
      pin,
      puk,
      pin2: retries['SIM PIN2'],
      puk2: retries['SIM PUK2'],
    }
  }

  /**
   * Query whether a facility is locked via AT+CLCK.
   *
   * Sends: AT+CLCK="<fac>",2[,<passwd>[,<class>]]
   * Response: +CLCK: <status>  (0 = not active, 1 = active)
   *
   * Ref: 3GPP TS 27.007 Section 7.4.
   */
  async queryFacilityLock(facility: string, serviceClass?: number): Promise<boolean> {
    const classParam = serviceClass !== undefined ? `,,"${serviceClass}"` : ''
    const result = await this.channel.execute(`AT+CLCK="${facility}",2${classParam}`)
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CLCK query returned no data', result.lines.join('\n'))
    }

    const match = CLCK_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CLCK response', line)
    }

    const [, statusStr] = match
    return statusStr === '1'
  }

  /**
   * Lock or unlock a facility via AT+CLCK.
   *
   * Sends: AT+CLCK="<fac>",<mode>[,"<passwd>"[,<class>]]
   * mode: 0 = unlock, 1 = lock
   *
   * Ref: 3GPP TS 27.007 Section 7.4.
   */
  async setFacilityLock(
    facility: string,
    lock: boolean,
    password?: string,
    serviceClass?: number,
  ): Promise<void> {
    const mode = lock ? 1 : 0
    let cmd = `AT+CLCK="${facility}",${mode}`
    if (password !== undefined) {
      cmd += `,"${password}"`
      if (serviceClass !== undefined) {
        cmd += `,${serviceClass}`
      }
    }
    await this.channel.execute(cmd)
  }

  /**
   * Change the password for a facility via AT+CPWD.
   *
   * Sends: AT+CPWD="<fac>","<oldpwd>","<newpwd>"
   *
   * Common facilities: "SC" (SIM PIN), "P2" (SIM PIN2), "AB" (all barring).
   *
   * Ref: 3GPP TS 27.007 Section 7.5.
   */
  async changePassword(facility: string, oldPassword: string, newPassword: string): Promise<void> {
    await this.channel.execute(`AT+CPWD="${facility}","${oldPassword}","${newPassword}"`)
  }

  /** Query SIM state from AT+CPIN? */
  private async _queryState(): Promise<SimInfo['state']> {
    // Skip AT+CPIN? when init already learned SIM is absent.
    // E3372 stick mode hangs on CPIN without SIM — this avoids the 3s timeout.
    if (this._knownAbsent) return 'absent'

    try {
      const result = await this.channel.execute('AT+CPIN?', { timeout: CPIN_TIMEOUT_MS })

      const line = result.lines[0]
      // Some firmware returns bare OK without +CPIN: line
      // when SIM is ready. OK with no info lines = no error = SIM ready.
      if (!line) return 'ready'

      const [, stateStr] = CPIN_REGEX.exec(line) ?? []
      if (stateStr === undefined) return 'error'

      return SIM_STATES[stateStr.trim()] ?? 'error'
    } catch (err) {
      // CME ERROR 10 = SIM not inserted
      if (
        err instanceof ATError &&
        err.result.type === 'cme_error' &&
        err.result.code === CME_SIM_NOT_INSERTED
      ) {
        return 'absent'
      }
      // Any other AT error (wrong PIN state, modem busy, etc.)
      if (err instanceof ATError) return 'error'
      // Timeout = SIM absent or modem stuck (E3372 hangs on CPIN without SIM)
      return 'absent'
    }
  }

  /** Query operator name from AT+COPS? */
  private async _queryOperator(): Promise<string | undefined> {
    const result = await this.channel.execute('AT+COPS?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+COPS? returned no data', result.lines.join('\n'))
    }

    const match = COPS_OPER_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+COPS? response', line)
    }

    // oper is undefined when not registered (e.g. "+COPS: 0") — legitimate absence
    const [, oper] = match
    return oper
  }
}

// -- ICCID normalization ----------------------------------------------------------

/**
 * Normalize a raw ICCID string from modem response.
 *
 * Per ITU-T E.118, ICCIDs are stored as packed BCD in 10 octets (20 digits),
 * padded with 'F' nibbles when shorter. Strips trailing 'F' padding
 * (BCD filler per 3GPP TS 11.11).
 *
 * @see https://en.wikipedia.org/wiki/E.118
 */
