import type {
  CapabilityOverrides,
  DataCapabilities,
  ModelInfo,
  ModemCapabilities,
  NetworkCapabilities,
  SimCapabilities,
  SmsCapabilities,
  StkCapabilities,
  UssdCapabilities,
  VoiceCapabilities,
} from '../../../types.js'
import type { Capabilities } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// -- SMS mode values --------------------------------------------------------------

const SMS_MODE_MAP: Record<number, string> = {
  0: 'pdu',
  1: 'text',
}

// -- Response parsers -------------------------------------------------------------

// AT+CMGF=? -> +CMGF: (0,1) or +CMGF: (0-1)
const CMGF_RANGE_REGEX = /\+CMGF:\s*\(([^)]+)\)/

// AT+CPMS=? -> +CPMS: ("SM","ME"),("SM","ME"),("SM","ME")
// We only care about the first group (read storage)
const CPMS_STORAGE_REGEX = /\+CPMS:\s*\(([^)]+)\)/

// AT+CGDCONT=? -> +CGDCONT: (0-31),"IP",...  (one or more lines)
const CGDCONT_TYPE_REGEX = /\+CGDCONT:\s*\([^)]*\),"([^"]+)"/

/** Modem capabilities discovery via AT+CLAC and enrichment probes */
export class CapabilitiesModule implements Capabilities {
  private readonly channel: ATChannel
  private readonly profile: AtConfig
  private readonly model: ModelInfo | undefined

  constructor(channel: ATChannel, profile: AtConfig, model?: ModelInfo | undefined) {
    this.channel = channel
    this.profile = profile
    this.model = model
  }

  /**
   * Discover modem capabilities.
   *
   * Phase 1: AT+CLAC returns the full list of supported commands.
   * Phase 2: Derive boolean feature flags from command presence.
   * Phase 3: Selective =? probes enrich features with parameter details.
   *
   * If AT+CLAC is not supported, returns empty commands and all features false.
   */
  async discover(): Promise<ModemCapabilities> {
    // Phase 1: enumerate supported commands
    const commands = await this._queryCommands()
    const commandSet = new Set(commands)
    const has = (cmd: string) => commandSet.has(cmd)
    const hasAny = (...cmds: string[]) => cmds.some(has)

    // Phase 2: derive boolean flags from command presence
    //
    // Each feature flag maps to the AT commands that indicate support.
    // A feature is "supported" if ANY of its commands is present.
    // Standard 3GPP commands are checked here; vendor-specific commands
    // are contributed by the profile via capabilityChecks.

    const smsFlags = {
      send: has('+CMGS'),
      receive: has('+CNMI'),
      read: hasAny('+CMGL', '+CMGR'),
      delete: has('+CMGD'),
      multipart: has('+CMMS'),
    }

    const voice: VoiceCapabilities = {
      dial: has('D'),
      answer: has('A'),
      hangup: hasAny('+CHUP', 'H'),
      dtmf: has('+VTS'),
      forwarding: has('+CCFC'),
      waiting: has('+CCWA'),
      hold: has('+CHLD'),
      callerId: has('+CLIP'),
      clir: has('+CLIR'),
    }

    const network: NetworkCapabilities = {
      signal: has('+CSQ'),
      registration: has('+CREG'),
      operatorScan: has('+COPS'),
      gprs: has('+CGREG'),
      eps: has('+CEREG'),
    }

    // Vendor-specific CLAC commands contributed by the profile
    const extraIccid = this.profile.capabilityChecks?.iccid ?? []
    const extraStk = this.profile.capabilityChecks?.stk ?? []

    const sim: SimCapabilities = {
      imsi: has('+CIMI'),
      iccid: hasAny('+CCID', ...extraIccid),
      pin: has('+CPIN'),
      pinRetries: has('+CPINR'),
      facilityLock: has('+CLCK'),
      changePassword: has('+CPWD'),
      phonebook: has('+CPBR'),
      genericAccess: has('+CSIM'),
      restrictedAccess: has('+CRSM'),
    }

    const ussd: UssdCapabilities = { supported: has('+CUSD') }

    const stk: StkCapabilities = { supported: hasAny('+CUSATD', ...extraStk) }

    // Phase 3: enrich with =? probes for detected features
    const hasDataCmd = has('+CGDCONT')
    const [modes, storage, pdpTypes] = await this._enrichProbes(smsFlags, hasDataCmd)

    const sms: SmsCapabilities = { ...smsFlags, modes, storage }
    const data: DataCapabilities = { pdpContext: hasDataCmd, types: pdpTypes }

    const runtime: ModemCapabilities = { commands, sms, voice, network, sim, ussd, data, stk }

    // Phase 4: apply per-model capability overrides
    // Model overrides represent hardware-tested truth -- they win over AT+CLAC probing.
    const overrides = this.model?.capabilities
    if (overrides === undefined) return runtime

    return applyCapabilityOverrides(runtime, overrides)
  }

  /**
   * Query the full list of supported AT commands via AT+CLAC.
   *
   * AT+CLAC output varies by modem:
   * - Some return pipe-separated: "H | A | D | +CMGS | ..."
   * - Some return one command per line: "+CMGS\n+CSQ\n..."
   * - Some return comma-separated
   *
   * Uses suppressURC to prevent command names that match URC prefixes
   * (e.g. "+CREG", "+CUSD") from being swallowed by the parser.
   *
   * Returns empty array if AT+CLAC is not supported.
   */
  private async _queryCommands(): Promise<readonly string[]> {
    try {
      const result = await this.channel.execute('AT+CLAC', {
        timeout: 5000,
        suppressURC: true,
      })
      if (result.lines.length === 0) {
        return []
      }

      // Join all lines into one string, then split on common delimiters
      const raw = result.lines.join(' ')
      const commands = raw
        .split(/[|,\s]+/)
        .map((cmd) => cmd.trim())
        .filter((cmd) => cmd.length > 0)

      return commands
    } catch {
      // AT+CLAC not supported or timed out
      return []
    }
  }

  /**
   * Probe for enrichment details on detected features.
   *
   * Uses Promise.allSettled so individual probe failures don't
   * block the rest.
   */
  private async _enrichProbes(
    sms: { readonly send: boolean; readonly read: boolean },
    hasData: boolean,
  ): Promise<[readonly string[], readonly string[], readonly string[]]> {
    const [modesResult, storageResult, typesResult] = await Promise.allSettled([
      sms.send ? this._probeSmsMode() : Promise.resolve([]),
      sms.read ? this._probeSmsStorage() : Promise.resolve([]),
      hasData ? this._probePdpTypes() : Promise.resolve([]),
    ])

    const modes = modesResult.status === 'fulfilled' ? modesResult.value : []
    const storage = storageResult.status === 'fulfilled' ? storageResult.value : []
    const types = typesResult.status === 'fulfilled' ? typesResult.value : []

    return [modes, storage, types]
  }

  /** AT+CMGF=? -> ['pdu', 'text'] */
  private async _probeSmsMode(): Promise<readonly string[]> {
    const result = await this.channel.execute('AT+CMGF=?', { timeout: 3000 })
    const line = result.lines[0]
    if (!line) return []

    const [, rangeStr] = CMGF_RANGE_REGEX.exec(line) ?? []
    if (rangeStr === undefined) return []

    return parseRange(rangeStr)
      .map((n) => SMS_MODE_MAP[n])
      .filter((m): m is string => m !== undefined)
  }

  /** AT+CPMS=? -> ['SM', 'ME'] */
  private async _probeSmsStorage(): Promise<readonly string[]> {
    const result = await this.channel.execute('AT+CPMS=?', { timeout: 3000 })
    const line = result.lines[0]
    if (!line) return []

    const [, storageStr] = CPMS_STORAGE_REGEX.exec(line) ?? []
    if (storageStr === undefined) return []

    return parseQuotedValues(storageStr)
  }

  /** AT+CGDCONT=? -> ['IP', 'PPP'] */
  private async _probePdpTypes(): Promise<readonly string[]> {
    const result = await this.channel.execute('AT+CGDCONT=?', { timeout: 3000 })
    const types: string[] = []

    for (const line of result.lines) {
      const [, pdpType] = CGDCONT_TYPE_REGEX.exec(line) ?? []
      if (pdpType !== undefined && !types.includes(pdpType)) {
        types.push(pdpType)
      }
    }

    return types
  }
}

// -- Helpers ----------------------------------------------------------------------

/**
 * Parse a range string like "(0,1)" or "(0-2)" into an array of numbers.
 *
 * Handles:
 * - Comma-separated: "(0,1)" -> [0, 1]
 * - Range: "(0-2)" -> [0, 1, 2]
 * - Mixed: "(0,1,3-5)" -> [0, 1, 3, 4, 5]
 */
function parseRange(rangeStr: string): number[] {
  const numbers: number[] = []
  const parts = rangeStr.split(',')

  for (const part of parts) {
    const trimmed = part.trim()
    const rangeParts = trimmed.split('-')

    if (rangeParts.length === 2) {
      const startStr = rangeParts[0]
      const endStr = rangeParts[1]
      if (startStr === undefined || endStr === undefined) continue

      const start = Number.parseInt(startStr, 10)
      const end = Number.parseInt(endStr, 10)

      if (!Number.isNaN(start) && !Number.isNaN(end)) {
        for (let i = start; i <= end; i++) {
          numbers.push(i)
        }
      }
    } else {
      const num = Number.parseInt(trimmed, 10)
      if (!Number.isNaN(num)) {
        numbers.push(num)
      }
    }
  }

  return numbers
}

/**
 * Parse quoted values from a string like '"SM","ME"'.
 * Returns: ['SM', 'ME']
 */
function parseQuotedValues(str: string): string[] {
  const values: string[] = []
  const regex = /"([^"]+)"/g
  let match = regex.exec(str)

  while (match !== null) {
    const value = match[1]
    if (value !== undefined) {
      values.push(value)
    }
    match = regex.exec(str)
  }

  return values
}

/**
 * Merge runtime-discovered capabilities with per-model overrides.
 * Overrides win -- they represent hardware-tested truth.
 *
 * The `commands` array (raw AT+CLAC output) is left unmodified;
 * only the boolean feature flags get patched.
 */
function applyCapabilityOverrides(
  runtime: ModemCapabilities,
  overrides: CapabilityOverrides,
): ModemCapabilities {
  return {
    commands: runtime.commands,
    sms: overrides.sms !== undefined ? { ...runtime.sms, ...overrides.sms } : runtime.sms,
    voice: overrides.voice !== undefined ? { ...runtime.voice, ...overrides.voice } : runtime.voice,
    network:
      overrides.network !== undefined
        ? { ...runtime.network, ...overrides.network }
        : runtime.network,
    sim: overrides.sim !== undefined ? { ...runtime.sim, ...overrides.sim } : runtime.sim,
    ussd: overrides.ussd !== undefined ? { ...runtime.ussd, ...overrides.ussd } : runtime.ussd,
    data: overrides.data !== undefined ? { ...runtime.data, ...overrides.data } : runtime.data,
    stk: overrides.stk !== undefined ? { ...runtime.stk, ...overrides.stk } : runtime.stk,
  }
}
