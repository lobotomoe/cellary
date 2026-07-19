import { ATError, ParseError } from '../../../errors.js'
import type {
  CallForwardingRule,
  CallForwardMode,
  CallForwardReason,
  ClirSetting,
  ClirStatus,
  NumberFormat,
} from '../../../types.js'
import type { ActiveCall, CallWaitingStatus, Voice } from '../../adapter.js'
import type { ATChannel } from '../channel/at-channel.js'
import type { AtConfig } from '../types.js'

// ── CLCC (Section 7.18) ─────────────────────────────────────────────────────

/** +CLCC: idx,dir,stat,mode,mpty[,"number",type[,"alpha"]] */
const CLCC_REGEX = /^\+CLCC:\s*(\d+),(\d+),(\d+),(\d+),(\d+)(?:,"([^"]*)")?/

const CLCC_STATE_MAP: Record<number, ActiveCall['state']> = {
  0: 'active',
  1: 'held',
  2: 'dialing',
  3: 'alerting',
  4: 'incoming',
  5: 'waiting',
}

function parseClccLine(line: string): ActiveCall | undefined {
  const match = CLCC_REGEX.exec(line)
  if (!match) return undefined
  const [, indexStr, dirStr, statStr, modeStr, , number] = match
  if (
    indexStr === undefined ||
    dirStr === undefined ||
    statStr === undefined ||
    modeStr === undefined
  ) {
    return undefined
  }

  const stat = Number(statStr)
  const state = CLCC_STATE_MAP[stat]
  if (state === undefined) return undefined

  return {
    index: Number(indexStr),
    direction: dirStr === '0' ? 'outgoing' : 'incoming',
    state,
    mode: Number(modeStr),
    number: number !== undefined && number !== '' ? number : undefined,
  }
}

// ── CLIR (Section 7.7) ──────────────────────────────────────────────────────

/** +CLIR: <n>,<m> */
const CLIR_REGEX = /\+CLIR:\s*(\d+),(\d+)/

const CLIR_SETTING_MAP: Record<number, ClirSetting> = {
  0: 'subscription',
  1: 'invocation',
  2: 'suppression',
}

const SETTING_TO_CLIR: Record<ClirSetting, number> = {
  subscription: 0,
  invocation: 1,
  suppression: 2,
}

const CLIR_STATUS_MAP: Record<number, ClirStatus> = {
  0: 'notProvisioned',
  1: 'permanent',
  2: 'unknown',
  3: 'temporaryRestricted',
  4: 'temporaryAllowed',
}

// ── Semantic <-> AT code maps ────────────────────────────────────────────────

const REASON_TO_AT: Record<CallForwardReason, number> = {
  unconditional: 0,
  busy: 1,
  noReply: 2,
  notReachable: 3,
  all: 4,
  allConditional: 5,
}

const MODE_TO_AT: Record<CallForwardMode, number> = {
  disable: 0,
  enable: 1,
  register: 3,
  erase: 4,
}

/** International type of address per ITU-T (includes country code with +) */
const NUMBER_TYPE_INTERNATIONAL = 145
/** Unknown/national type of address per ITU-T (no country code prefix) */
const NUMBER_TYPE_NATIONAL = 129

function numberTypeToFormat(type: number): NumberFormat {
  return type === NUMBER_TYPE_INTERNATIONAL ? 'international' : 'national'
}

/** Auto-detect number format: starts with '+' -> international (145), else national (129) */
function inferNumberType(number: string): number {
  return number.startsWith('+') ? NUMBER_TYPE_INTERNATIONAL : NUMBER_TYPE_NATIONAL
}

// ── CCFC (Section 7.11) ─────────────────────────────────────────────────────

/** +CCFC: <status>,<class>[,<number>,<type>[,<subaddr>,<satype>[,<time>]]] */
const CCFC_REGEX = /\+CCFC:\s*(\d+),(\d+)(?:,"([^"]*)",(\d+))?(?:,"[^"]*",\d+,(\d+))?/

// ── CCWA (Section 7.12) ─────────────────────────────────────────────────────

/** +CCWA: <status>,<class> */
const CCWA_REGEX = /\+CCWA:\s*(\d+),(\d+)/

// ── VoiceModule ─────────────────────────────────────────────────────────────

/** Voice call management and supplementary services */
export class VoiceModule implements Voice {
  private readonly channel: ATChannel
  private readonly profile: AtConfig

  constructor(channel: ATChannel, profile: AtConfig) {
    this.channel = channel
    this.profile = profile
  }

  /** Dial a number. Returns when the call is initiated (not when answered). */
  async dial(number: string): Promise<void> {
    const voiceSetup = this.profile.commands?.voiceSetup
    if (voiceSetup !== undefined) {
      try {
        await this.channel.execute(voiceSetup)
      } catch (err) {
        if (!(err instanceof ATError)) throw err
      }
    }
    await this.channel.execute(`ATD${number};`, { timeout: 60_000 })
  }

  async answer(): Promise<void> {
    await this.channel.execute('ATA')
  }

  async hangup(): Promise<void> {
    await this.channel.execute('ATH')
  }

  async dtmf(tones: string): Promise<void> {
    await this.channel.execute(`AT+VTS="${tones}"`)
  }

  /** List all active calls via AT+CLCC (3GPP TS 27.007 Section 7.18) */
  async listCalls(): Promise<readonly ActiveCall[]> {
    const result = await this.channel.execute('AT+CLCC', { timeout: 5000 })
    const calls: ActiveCall[] = []
    for (const line of result.lines) {
      const call = parseClccLine(line)
      if (call !== undefined) {
        calls.push(call)
      }
    }
    return calls
  }

  // ── CLIR (Section 7.7) ──────────────────────────────────────────────────

  /** Query CLIR setting and network provisioning status */
  async queryClir(): Promise<{ readonly setting: ClirSetting; readonly status: ClirStatus }> {
    const result = await this.channel.execute('AT+CLIR?')
    const line = result.lines[0]
    if (line === undefined) {
      throw new ParseError('AT+CLIR? returned no data', result.lines.join('\n'))
    }

    const match = CLIR_REGEX.exec(line)
    if (match === null) {
      throw new ParseError('Failed to parse AT+CLIR? response', line)
    }

    const [, nStr, mStr] = match
    if (nStr === undefined || mStr === undefined) {
      throw new ParseError('AT+CLIR? missing setting or status', line)
    }

    const setting = CLIR_SETTING_MAP[Number(nStr)]
    const status = CLIR_STATUS_MAP[Number(mStr)]
    if (setting === undefined || status === undefined) {
      throw new ParseError(`Unknown CLIR values n=${nStr} m=${mStr}`, line)
    }

    return { setting, status }
  }

  /** Set CLIR mode for outgoing calls */
  async setClir(setting: ClirSetting): Promise<void> {
    const n = SETTING_TO_CLIR[setting]
    await this.channel.execute(`AT+CLIR=${n}`)
  }

  // ── CCFC (Section 7.11) ─────────────────────────────────────────────────

  /** Query call forwarding rules for a specific reason */
  async queryCallForwarding(
    reason: CallForwardReason,
    serviceClass?: number,
  ): Promise<CallForwardingRule[]> {
    const reasonCode = REASON_TO_AT[reason]
    const classParam = serviceClass !== undefined ? `,,,${serviceClass}` : ''
    const result = await this.channel.execute(`AT+CCFC=${reasonCode},2${classParam}`)

    const rules: CallForwardingRule[] = []
    for (const line of result.lines) {
      const rule = parseCcfcLine(line)
      if (rule !== undefined) {
        rules.push(rule)
      }
    }
    return rules
  }

  /** Set, enable, disable, or erase a call forwarding rule */
  async setCallForwarding(
    reason: CallForwardReason,
    mode: CallForwardMode,
    options?: {
      readonly number?: string
      readonly serviceClass?: number
      readonly time?: number
    },
  ): Promise<void> {
    const reasonCode = REASON_TO_AT[reason]
    const modeCode = MODE_TO_AT[mode]

    // TS 27.007 7.11 positional order:
    //   AT+CCFC=<reason>,<mode>[,<number>[,<type>[,<class>[,<subaddr>[,<satype>[,<time>]]]]]]
    // Absent-but-earlier params must be emitted as empty placeholders so later
    // ones land in the right slot — e.g. <time> must not fall into <satype>.
    const number = options?.number
    const serviceClass = options?.serviceClass
    const time = options?.time

    const parts: string[] = [String(reasonCode), String(modeCode)]
    if (number !== undefined || serviceClass !== undefined || time !== undefined) {
      // <number>,<type>
      parts.push(
        number !== undefined ? `"${number}"` : '',
        number !== undefined ? String(inferNumberType(number)) : '',
      )
    }
    if (serviceClass !== undefined || time !== undefined) {
      // <class>
      parts.push(serviceClass !== undefined ? String(serviceClass) : '')
    }
    if (time !== undefined) {
      // <subaddr>,<satype>,<time>
      parts.push('', '', String(time))
    }

    await this.channel.execute(`AT+CCFC=${parts.join(',')}`)
  }

  // ── CCWA (Section 7.12) ─────────────────────────────────────────────────

  /** Query call waiting status per service class */
  async queryCallWaiting(serviceClass?: number): Promise<CallWaitingStatus[]> {
    const classParam = serviceClass !== undefined ? `,${serviceClass}` : ''
    const result = await this.channel.execute(`AT+CCWA=1,2${classParam}`)

    const entries: CallWaitingStatus[] = []
    for (const line of result.lines) {
      const entry = parseCcwaLine(line)
      if (entry !== undefined) {
        entries.push(entry)
      }
    }
    return entries
  }

  /** Enable or disable call waiting */
  async setCallWaiting(enable: boolean, serviceClass?: number): Promise<void> {
    const mode = enable ? 1 : 0
    const classParam = serviceClass !== undefined ? `,${serviceClass}` : ''
    await this.channel.execute(`AT+CCWA=1,${mode}${classParam}`)
  }

  // ── CHLD (Section 7.13) ─────────────────────────────────────────────────

  /** Place active calls on hold and accept waiting/held call */
  async holdAndAccept(): Promise<void> {
    await this.channel.execute('AT+CHLD=2')
  }

  /** Add held call to active call for multiparty conference */
  async conference(): Promise<void> {
    await this.channel.execute('AT+CHLD=3')
  }

  /** Release all held calls, or reject a waiting call */
  async releaseHeld(): Promise<void> {
    await this.channel.execute('AT+CHLD=0')
  }
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseCcfcLine(line: string): CallForwardingRule | undefined {
  const match = CCFC_REGEX.exec(line)
  if (match === null) return undefined

  const [, statusStr, classStr, number, typeStr, timeStr] = match
  if (statusStr === undefined || classStr === undefined) return undefined

  const hasNumber = number !== undefined && number !== ''

  const rule: CallForwardingRule = {
    active: statusStr === '1',
    serviceClass: Number(classStr),
    number: hasNumber ? number : undefined,
    numberFormat: typeStr !== undefined ? numberTypeToFormat(Number(typeStr)) : undefined,
    time: timeStr !== undefined ? Number(timeStr) : undefined,
  }
  return rule
}

function parseCcwaLine(line: string): CallWaitingStatus | undefined {
  const match = CCWA_REGEX.exec(line)
  if (match === null) return undefined

  const [, statusStr, classStr] = match
  if (statusStr === undefined || classStr === undefined) return undefined

  return {
    active: statusStr === '1',
    serviceClass: Number(classStr),
  }
}
