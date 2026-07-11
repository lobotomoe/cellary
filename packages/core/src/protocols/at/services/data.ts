import { ParseError } from '../../../errors.js'
import type {
  DataConnectionStatus,
  EpsQosParams,
  PdpAuthType,
  PdpContext,
  PdpDynamicParams,
  UeOperationMode,
} from '../../../types.js'
import type { Data } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// +CGATT: <state>  (0 = detached, 1 = attached)
const CGATT_REGEX = /\+CGATT:\s*(\d+)/

// +CGDCONT: <cid>,"<pdpType>","<apn>"[,...]
const CGDCONT_REGEX = /\+CGDCONT:\s*(\d+),"([^"]*)","([^"]*)"(?:,"([^"]*)")?/

// +CGACT: <cid>,<state>
const CGACT_REGEX = /\+CGACT:\s*(\d+),(\d+)/

// +CGPADDR: <cid>[,"<address>"]
const CGPADDR_REGEX = /\+CGPADDR:\s*(\d+)(?:,"([^"]*)")?/

// 3GPP TS 27.007 Section 10.1.23 -- AT+CGCONTRDP
// +CGCONTRDP: <cid>,<bearer_id>,<apn>[,<local_addr>[,<subnet_mask>[,<gw_addr>[,<DNS_prim>[,<DNS_sec>...]]]]]
// Fields after apn are quoted strings, some may be empty
const CGCONTRDP_REGEX =
  /\+CGCONTRDP:\s*(\d+),(\d+),"([^"]*)"(?:,"([^"]*)"(?:,"([^"]*)"(?:,"([^"]*)"(?:,"([^"]*)")?)?)?)?/

// 3GPP TS 27.007 Section 10.1.26 -- AT+CGEQOS
// +CGEQOS: <cid>,<QCI>[,<DL_GBR>,<UL_GBR>[,<DL_MBR>,<UL_MBR>]]
const CGEQOS_REGEX = /\+CGEQOS:\s*(\d+),(\d+)(?:,(\d+),(\d+)(?:,(\d+),(\d+))?)?/

// 3GPP TS 27.007 Section 10.1.28 -- AT+CEMODE
// +CEMODE: <mode>
const CEMODE_REGEX = /\+CEMODE:\s*(\d+)/

/** Map +CEMODE numeric code to domain UeOperationMode. */
function parseUeMode(code: number): UeOperationMode | undefined {
  switch (code) {
    case 0:
      return 'psMode2'
    case 1:
      return 'csPsMode1'
    case 2:
      return 'csPsMode2'
    case 3:
      return 'psMode1'
    default:
      return undefined
  }
}

/** Map domain UeOperationMode to +CEMODE numeric code. */
const UE_MODE_TO_CODE: Record<UeOperationMode, number> = {
  psMode2: 0,
  csPsMode1: 1,
  csPsMode2: 2,
  psMode1: 3,
}

// PdpAuthType -> numeric code
const AUTH_TYPE_TO_CODE: Record<PdpAuthType, number> = {
  none: 0,
  pap: 1,
  chap: 2,
}

const ACTIVATE_TIMEOUT = 60_000

/** Cellular data connection management via 3GPP AT commands. */
export class DataModule implements Data {
  constructor(
    private readonly channel: ATChannel,
    _profile: AtConfig,
  ) {}

  async status(): Promise<DataConnectionStatus> {
    // PS attach state
    const attachResult = await this.channel.execute('AT+CGATT?')
    const attachLine = attachResult.lines[0]
    if (attachLine === undefined)
      throw new ParseError('+CGATT returned no data', attachResult.lines.join('\n'))
    const attachMatch = CGATT_REGEX.exec(attachLine)
    if (attachMatch === null) throw new ParseError('Unexpected +CGATT format', attachLine)
    const [, attachStr] = attachMatch
    const attached = attachStr === '1'

    // Check if any context is active
    const actResult = await this.channel.execute('AT+CGACT?')
    let anyActive = false
    for (const line of actResult.lines) {
      const match = CGACT_REGEX.exec(line)
      if (match !== null) {
        const [, , stateStr] = match
        if (stateStr === '1') {
          anyActive = true
          break
        }
      }
    }

    const state = anyActive ? 'connected' : 'disconnected'
    return { state, attached }
  }

  async contexts(): Promise<PdpContext[]> {
    // Get defined contexts
    const dcontResult = await this.channel.execute('AT+CGDCONT?')
    const contexts = new Map<number, { pdpType: string; apn: string }>()
    for (const line of dcontResult.lines) {
      const match = CGDCONT_REGEX.exec(line)
      if (match === null) continue
      const [, cidStr, pdpType, apn] = match
      if (cidStr === undefined || pdpType === undefined || apn === undefined) continue
      contexts.set(Number.parseInt(cidStr, 10), { pdpType, apn })
    }

    if (contexts.size === 0) return []

    // Get activation states
    const actResult = await this.channel.execute('AT+CGACT?')
    const activeMap = new Map<number, boolean>()
    for (const line of actResult.lines) {
      const match = CGACT_REGEX.exec(line)
      if (match === null) continue
      const [, cidStr, stateStr] = match
      if (cidStr === undefined || stateStr === undefined) continue
      activeMap.set(Number.parseInt(cidStr, 10), stateStr === '1')
    }

    // Get IP addresses
    const addrResult = await this.channel.execute('AT+CGPADDR')
    const addrMap = new Map<number, string>()
    for (const line of addrResult.lines) {
      const match = CGPADDR_REGEX.exec(line)
      if (match === null) continue
      const [, cidStr, address] = match
      if (cidStr === undefined) continue
      if (address !== undefined && address !== '') {
        addrMap.set(Number.parseInt(cidStr, 10), address)
      }
    }

    // Merge into PdpContext[]
    const result: PdpContext[] = []
    for (const [cid, def] of contexts) {
      result.push({
        cid,
        pdpType: def.pdpType,
        apn: def.apn,
        active: activeMap.get(cid) ?? false,
        address: addrMap.get(cid),
      })
    }

    return result
  }

  async defineContext(cid: number, pdpType: string, apn: string): Promise<void> {
    await this.channel.execute(`AT+CGDCONT=${cid},"${pdpType}","${apn}"`)
  }

  async activate(cid: number): Promise<void> {
    await this.channel.execute(`AT+CGACT=1,${cid}`, { timeout: ACTIVATE_TIMEOUT })
  }

  async deactivate(cid: number): Promise<void> {
    await this.channel.execute(`AT+CGACT=0,${cid}`, { timeout: ACTIVATE_TIMEOUT })
  }

  // ── AT+CGCONTRDP (Section 10.1.23) ────────────────────────────────────

  /**
   * Read dynamic parameters for active PDP context(s).
   *
   * Returns network-assigned parameters: bearer ID, APN, IP address,
   * gateway, DNS servers. Only returns data for active contexts.
   *
   * @param cid - Context ID. If omitted, returns params for all active contexts.
   */
  async dynamicParameters(cid?: number): Promise<PdpDynamicParams[]> {
    const cmd = cid !== undefined ? `AT+CGCONTRDP=${cid}` : 'AT+CGCONTRDP'
    const result = await this.channel.execute(cmd)

    const params: PdpDynamicParams[] = []
    for (const line of result.lines) {
      const match = CGCONTRDP_REGEX.exec(line)
      if (match === null) continue

      const [, cidStr, bearerStr, apn, localAddr, gwAddr, dnsPrim, dnsSec] = match
      if (cidStr === undefined || bearerStr === undefined) continue

      params.push({
        cid: Number.parseInt(cidStr, 10),
        bearerId: Number.parseInt(bearerStr, 10),
        apn: apn !== undefined && apn !== '' ? apn : undefined,
        localAddress: localAddr !== undefined && localAddr !== '' ? localAddr : undefined,
        gatewayAddress: gwAddr !== undefined && gwAddr !== '' ? gwAddr : undefined,
        primaryDns: dnsPrim !== undefined && dnsPrim !== '' ? dnsPrim : undefined,
        secondaryDns: dnsSec !== undefined && dnsSec !== '' ? dnsSec : undefined,
      })
    }

    return params
  }

  // ── AT+CGAUTH (Section 10.1.31) ──────────────────────────────────────

  /**
   * Set PDP context authentication parameters.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.31.
   */
  async setAuthentication(
    cid: number,
    authType: PdpAuthType,
    username?: string,
    password?: string,
  ): Promise<void> {
    const authCode = AUTH_TYPE_TO_CODE[authType]
    let cmd = `AT+CGAUTH=${cid},${authCode}`
    if (username !== undefined) {
      cmd += `,"${username}"`
      if (password !== undefined) {
        cmd += `,"${password}"`
      }
    }
    await this.channel.execute(cmd)
  }

  // ── AT+CGCMOD (Section 10.1.11) ──────────────────────────────────────

  /**
   * Re-negotiate QoS parameters for an active PDP context.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.11.
   */
  async modify(cid: number): Promise<void> {
    await this.channel.execute(`AT+CGCMOD=${cid}`, { timeout: ACTIVATE_TIMEOUT })
  }

  // ── AT+CGEQOS (Section 10.1.26) ──────────────────────────────────────

  /**
   * Read EPS QoS parameters for a PDP context.
   *
   * Response: +CGEQOS: <cid>,<QCI>[,<DL_GBR>,<UL_GBR>[,<DL_MBR>,<UL_MBR>]]
   * GBR/MBR values are in kbps.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.26.
   */
  async epsQos(cid?: number): Promise<EpsQosParams[]> {
    const cmd = cid !== undefined ? `AT+CGEQOS=${cid}` : 'AT+CGEQOS?'
    const result = await this.channel.execute(cmd)
    return this.parseEpsQosLines(result.lines)
  }

  // ── AT+CGEQOSRDP (Section 10.1.27) ────────────────────────────────────

  /**
   * Read negotiated EPS QoS parameters from the network.
   *
   * Same response format as +CGEQOS but reflects network-assigned values.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.27.
   */
  async negotiatedEpsQos(cid?: number): Promise<EpsQosParams[]> {
    const cmd = cid !== undefined ? `AT+CGEQOSRDP=${cid}` : 'AT+CGEQOSRDP'
    const result = await this.channel.execute(cmd)
    return this.parseEpsQosLines(result.lines)
  }

  /**
   * Define EPS QoS parameters for a PDP context.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.26.
   */
  async setEpsQos(params: EpsQosParams): Promise<void> {
    let cmd = `AT+CGEQOS=${params.cid},${params.qci}`
    if (params.dlGbr !== undefined && params.ulGbr !== undefined) {
      cmd += `,${params.dlGbr},${params.ulGbr}`
      if (params.dlMbr !== undefined && params.ulMbr !== undefined) {
        cmd += `,${params.dlMbr},${params.ulMbr}`
      }
    }
    await this.channel.execute(cmd)
  }

  /** Parse +CGEQOS / +CGEQOSRDP response lines into EpsQosParams[]. */
  private parseEpsQosLines(lines: readonly string[]): EpsQosParams[] {
    const params: EpsQosParams[] = []
    for (const line of lines) {
      const match = CGEQOS_REGEX.exec(line)
      if (match === null) continue

      const [, cidStr, qciStr, dlGbrStr, ulGbrStr, dlMbrStr, ulMbrStr] = match
      if (cidStr === undefined || qciStr === undefined) continue

      params.push({
        cid: Number.parseInt(cidStr, 10),
        qci: Number.parseInt(qciStr, 10),
        dlGbr: dlGbrStr !== undefined ? Number.parseInt(dlGbrStr, 10) : undefined,
        ulGbr: ulGbrStr !== undefined ? Number.parseInt(ulGbrStr, 10) : undefined,
        dlMbr: dlMbrStr !== undefined ? Number.parseInt(dlMbrStr, 10) : undefined,
        ulMbr: ulMbrStr !== undefined ? Number.parseInt(ulMbrStr, 10) : undefined,
      })
    }
    return params
  }

  // ── AT+CEMODE (Section 10.1.28) ──────────────────────────────────────

  /**
   * Query the current UE mode of operation for EPS.
   *
   * Response: +CEMODE: <mode>
   *
   * Ref: 3GPP TS 27.007 Section 10.1.28.
   */
  async ueMode(): Promise<UeOperationMode> {
    const result = await this.channel.execute('AT+CEMODE?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CEMODE? returned no data', result.lines.join('\n'))
    }

    const match = CEMODE_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CEMODE? response', line)
    }

    const [, modeStr] = match
    if (modeStr === undefined) {
      throw new ParseError('AT+CEMODE? missing mode value', line)
    }

    const modeCode = Number.parseInt(modeStr, 10)
    const mode = parseUeMode(modeCode)
    if (mode === undefined) {
      throw new ParseError(`Unknown UE mode code: ${modeCode}`, line)
    }

    return mode
  }

  /**
   * Set the UE mode of operation for EPS.
   *
   * Ref: 3GPP TS 27.007 Section 10.1.28.
   */
  async setUeMode(mode: UeOperationMode): Promise<void> {
    const code = UE_MODE_TO_CODE[mode]
    await this.channel.execute(`AT+CEMODE=${code}`)
  }
}
