import type { EventEmitter } from 'node:events'
import type {
  CallEvent,
  MoSsNotification,
  MtSsNotification,
  RegistrationInfo,
  SimState,
  SmsNotification,
  SsNotificationEvent,
  UnsolicitedMessage,
} from '../../types.js'
import type { VendorEvent } from '../adapter.js'
import type { ATChannel } from './channel/at-channel.js'
import { ACCESS_TECHNOLOGY, REGISTRATION_STATUS } from './services/network.js'

// ── Narrow interfaces for dependencies ──────────────────────────────────────

/** Function that interprets a raw message into a typed domain event. */
type UrcMessageInterpreter = (message: UnsolicitedMessage) => VendorEvent | undefined

/** Subset of DeviceModule needed for indicator name resolution. */
interface IndicatorResolver {
  resolveIndicatorName(index: number): string | undefined
}

// ── URC handler setup ───────────────────────────────────────────────────────

/**
 * Register all standard AT URC handlers on a channel.
 *
 * Parses incoming URCs (SMS notifications, call state changes, registration
 * updates, supplementary service notifications, indicator changes) and emits
 * domain events on the provided EventEmitter.
 *
 * Extracted from AtAdapter to keep the adapter class focused on lifecycle
 * and service routing.
 */
export function setupUrcHandlers(options: {
  readonly channel: ATChannel
  readonly deviceModule: IndicatorResolver
  readonly emitter: EventEmitter
  readonly interpretMessage?: UrcMessageInterpreter | undefined
}): void {
  const { channel, deviceModule, emitter, interpretMessage } = options

  // +CREG/+CEREG URC body: <stat>[,"<lac/tac>","<ci>"[,<AcT>]]  (no leading <n> in URCs)
  // Both use the same format — only the prefix differs.
  const REG_URC_REGEX = /^(\d+)(?:,"([^"]*)"(?:,"([^"]*)"(?:,(\d+))?)?)?$/
  // +CLIP URC body: "<number>",<type>[,<subaddr>,<satype>[,"<alpha>"[,<CLI validity>]]]
  const CLIP_REGEX = /^"([^"]*)",(\d+)/

  // AT storage code -> semantic name
  const STORAGE_MAP: Record<string, SmsNotification['storage']> = {
    SM: 'sim',
    ME: 'device',
  }

  // AT +CPIN response -> SimState
  const CPIN_STATE_MAP: Record<string, SimState> = {
    READY: 'ready',
    'SIM PIN': 'pinRequired',
    'SIM PUK': 'pukRequired',
    'SIM PIN2': 'pin2Required',
    'SIM PUK2': 'puk2Required',
    'PH-NET PIN': 'networkLocked',
  }

  // Track the last caller ID from +CLIP to enrich call events
  let lastClipNumber: string | undefined

  // SMS notifications
  channel.onURC('+CMTI', (urc) => {
    // +CMTI: "SM",3 -> storage='sim', index=3
    const match = /^"([^"]*)",(\d+)$/.exec(urc.body)
    if (!match) return
    const [, storageCode, indexStr] = match
    if (storageCode === undefined || indexStr === undefined) return
    emitter.emit('sms:received', {
      storage: STORAGE_MAP[storageCode] ?? 'unknown',
      index: Number.parseInt(indexStr, 10),
    })
  })

  // Incoming calls -- RING arrives before +CLIP
  channel.onURC('RING', () => {
    lastClipNumber = undefined
    emitter.emit('call:state', {
      state: 'incoming',
      direction: 'incoming',
    })
  })

  // Calling line identification -- arrives after RING with the caller number
  channel.onURC('+CLIP', (urc) => {
    const match = CLIP_REGEX.exec(urc.body)
    if (!match) return
    const [, number] = match
    if (number === undefined || number === '') return
    lastClipNumber = number
    emitter.emit('call:state', {
      state: 'incoming',
      direction: 'incoming',
      number,
    })
  })

  // Call ended -- NO CARRIER
  channel.onURC('NO CARRIER', () => {
    const info: CallEvent = {
      state: 'ended',
      direction: lastClipNumber !== undefined ? 'incoming' : 'outgoing',
      number: lastClipNumber,
      reason: 'hangup',
    }
    lastClipNumber = undefined
    emitter.emit('call:state', info)
  })

  // Network registration status change (CS and EPS/LTE domains)
  channel.onURC('+CREG', (urc) => {
    emitRegistrationUrc(emitter, REG_URC_REGEX, urc.body)
  })

  channel.onURC('+CEREG', (urc) => {
    emitRegistrationUrc(emitter, REG_URC_REGEX, urc.body)
  })

  // Call termination with reason
  channel.onURC('BUSY', () => {
    lastClipNumber = undefined
    emitter.emit('call:state', { state: 'ended', direction: 'outgoing', reason: 'busy' })
  })

  channel.onURC('NO ANSWER', () => {
    lastClipNumber = undefined
    emitter.emit('call:state', { state: 'ended', direction: 'outgoing', reason: 'noAnswer' })
  })

  channel.onURC('NO DIALTONE', () => {
    lastClipNumber = undefined
    emitter.emit('call:state', { state: 'ended', direction: 'outgoing', reason: 'noDialtone' })
  })

  // SIM state change
  channel.onURC('+CPIN', (urc) => {
    const body = urc.body.trim()
    const state = CPIN_STATE_MAP[body] ?? 'unknown'
    emitter.emit('sim:state', { state })
  })

  // ── Supplementary Service Notifications ──────────────────────────────

  // +CSSI: <code1>[,<index>]  (MO SS notification during outgoing call)
  const MO_SS_MAP: Record<number, MoSsNotification> = {
    0: 'forwardingActive',
    1: 'conditionalForwardingActive',
    2: 'callForwarded',
    3: 'callIsWaiting',
    4: 'outgoingBarred',
    5: 'incomingBarred',
    6: 'clirRejected',
    7: 'callDeflected',
  }

  channel.onURC('+CSSI', (urc) => {
    const match = /^(\d+)(?:,(\d+))?$/.exec(urc.body)
    if (!match) return
    const [, codeStr, indexStr] = match
    if (codeStr === undefined) return
    const notification = MO_SS_MAP[Number.parseInt(codeStr, 10)]
    if (notification === undefined) return
    const event: SsNotificationEvent = {
      direction: 'outgoing',
      notification,
      callIndex: indexStr !== undefined ? Number.parseInt(indexStr, 10) : undefined,
    }
    emitter.emit('call:supplementary', event)
  })

  // +CSSU: <code2>[,<index>[,"<number>",<type>]]  (MT SS notification)
  const MT_SS_MAP: Record<number, MtSsNotification> = {
    0: 'forwardedCall',
    2: 'callHeldByRemote',
    3: 'callRetrievedByRemote',
    4: 'multipartyEntered',
    5: 'heldCallReleased',
    7: 'callConnecting',
    8: 'callConnected',
    9: 'deflectedCall',
    10: 'additionalForwarded',
  }
  const CSSU_REGEX = /^(\d+)(?:,(\d+)(?:,"([^"]*)")?)?$/

  channel.onURC('+CSSU', (urc) => {
    const match = CSSU_REGEX.exec(urc.body)
    if (!match) return
    const [, codeStr, indexStr, number] = match
    if (codeStr === undefined) return
    const notification = MT_SS_MAP[Number.parseInt(codeStr, 10)]
    if (notification === undefined) return
    const event: SsNotificationEvent = {
      direction: 'incoming',
      notification,
      callIndex: indexStr !== undefined ? Number.parseInt(indexStr, 10) : undefined,
      number: number !== undefined && number !== '' ? number : undefined,
    }
    emitter.emit('call:supplementary', event)
  })

  // ── Calling Name Presentation ────────────────────────────────────────

  // +CNAP: "<name>",<CNI_validity>
  channel.onURC('+CNAP', (urc) => {
    const match = /^"([^"]*)"/.exec(urc.body)
    if (!match) return
    const [, callerName] = match
    if (callerName === undefined || callerName === '') return
    emitter.emit('call:state', {
      state: 'incoming',
      direction: 'incoming',
      number: lastClipNumber,
      callerName,
    })
  })

  // ── Indicator Change ─────────────────────────────────────────────────

  // +CIEV: <ind>,<value>  (indicator index is 1-based)
  channel.onURC('+CIEV', (urc) => {
    const match = /^(\d+),(\d+)$/.exec(urc.body)
    if (!match) return
    const [, indStr, valStr] = match
    if (indStr === undefined || valStr === undefined) return
    const index = Number.parseInt(indStr, 10)
    const value = Number.parseInt(valStr, 10)
    const name = deviceModule.resolveIndicatorName(index)
    if (name === undefined) return
    emitter.emit('indicator:change', { name, value })
  })

  // Catch-all: interpret vendor messages into typed events, forward raw for debug
  channel.onAnyURC((urc) => {
    if (interpretMessage !== undefined) {
      const interpreted = interpretMessage(urc)
      if (interpreted !== undefined) {
        switch (interpreted.event) {
          case 'call:state':
            emitter.emit('call:state', interpreted.data)
            break
          case 'sms:received':
            emitter.emit('sms:received', interpreted.data)
            break
          case 'network:registration':
            emitter.emit('network:registration', interpreted.data)
            break
          case 'sim:state':
            emitter.emit('sim:state', interpreted.data)
            break
        }
      }
    }
    emitter.emit('raw', urc)
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a +CREG/+CEREG URC body and emit 'network:registration'. */
function emitRegistrationUrc(emitter: EventEmitter, regex: RegExp, body: string): void {
  const match = regex.exec(body)
  if (!match) return
  const [, statStr, locationAreaCode, cellId, actStr] = match
  if (statStr === undefined) return

  const statCode = Number.parseInt(statStr, 10)
  const status = REGISTRATION_STATUS[statCode] ?? 'unknown'

  const info: RegistrationInfo =
    locationAreaCode !== undefined && locationAreaCode !== ''
      ? {
          status,
          locationAreaCode,
          cellId:
            cellId !== undefined && cellId !== '' && !/^0+$/.test(cellId) ? cellId : undefined,
          technology:
            actStr !== undefined ? ACCESS_TECHNOLOGY[Number.parseInt(actStr, 10)] : undefined,
        }
      : { status }

  emitter.emit('network:registration', info)
}
