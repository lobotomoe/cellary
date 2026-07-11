import type { VendorEvent } from '../../protocols/adapter.js'
import type { URC } from '../../protocols/at/types.js'
import type { CallEndReason, CallEvent, CallState } from '../../types.js'

/**
 * ^DSCI: Huawei call status indication URC.
 *
 * Format: ^DSCI: <call_id>,<dir>,<stat>,<type>,<number>,<num_type>[,<cause>]
 *
 * Enabled by AT^DSCI=1. Reports call state transitions with caller/callee number.
 * Works at baseband level — may fire even on data-only devices (E3372) where
 * standard RING/+CLIP never appear because the voice path isn't established.
 *
 * dir:  0 = MO (outgoing), 1 = MT (incoming)
 * stat: 0 = originated, 1 = delivered, 2 = connected, 3 = released,
 *       4 = incoming, 5 = waiting, 6 = held
 */
const DSCI_REGEX = /^(\d+),(\d+),(\d+),(\d+),"?([^",]*)"?,(\d+)(?:,(\d+))?$/

const DSCI_DIRECTION: Record<number, CallEvent['direction']> = {
  0: 'outgoing',
  1: 'incoming',
}

const DSCI_STATE: Record<number, CallState> = {
  0: 'dialing', // MO originated — call sent to baseband
  1: 'alerting', // MO delivered — remote phone is ringing
  2: 'active', // connected — voice path established
  3: 'ended', // released
  4: 'incoming', // MT incoming
  5: 'waiting', // MT waiting (call waiting)
  6: 'held', // held
}

function parseDsci(body: string): VendorEvent | undefined {
  const match = DSCI_REGEX.exec(body)
  if (!match) return undefined
  const [, , dirStr, statStr, , number] = match
  if (dirStr === undefined || statStr === undefined) return undefined

  const dirCode = Number.parseInt(dirStr, 10)
  const statCode = Number.parseInt(statStr, 10)
  const direction = DSCI_DIRECTION[dirCode] ?? 'incoming'
  const state = DSCI_STATE[statCode]
  if (state === undefined) return undefined

  const callerNumber = number !== undefined && number !== '' ? number : undefined

  const event: CallEvent =
    state === 'ended'
      ? { state, direction, number: callerNumber, reason: 'hangup' }
      : { state, direction, number: callerNumber }

  return { event: 'call:state', data: event }
}

/**
 * ^ORIG/^CONF/^CONN: Huawei outgoing call progress URCs.
 *
 * ^ORIG: call setup initiated (MO call sent to baseband)
 * ^CONF: network confirmed, remote phone is ringing
 * ^CONN: remote party answered, voice path established
 */
const ORIG_CONF_CONN_STATE: Record<string, CallState> = {
  '^ORIG': 'setup',
  '^CONF': 'alerting',
  '^CONN': 'active',
}

/**
 * ^CEND: Huawei call ended URC.
 *
 * Format: ^CEND: <call_x>,<duration>,<end_status>[,<cc_cause>]
 * cc_cause maps to 3GPP TS 24.008 cause codes when present.
 *
 * Common cc_cause values:
 *   16 = normal clearing, 17 = user busy, 18 = no user responding,
 *   19 = no answer, 21 = call rejected, 31 = normal unspecified
 */
const CEND_CAUSE_REASON: Record<number, CallEndReason> = {
  17: 'busy',
  18: 'noAnswer',
  19: 'noAnswer',
  21: 'rejected',
}

function parseCend(body: string): VendorEvent {
  const match = /^\d+,\d+,\d+(?:,(\d+))?/.exec(body)
  const causeStr = match?.[1]
  const causeCode = causeStr !== undefined ? Number.parseInt(causeStr, 10) : undefined
  const reason: CallEndReason =
    causeCode !== undefined ? (CEND_CAUSE_REASON[causeCode] ?? 'hangup') : 'hangup'

  return {
    event: 'call:state',
    data: { state: 'ended', direction: 'outgoing', reason },
  }
}

/**
 * Interpret a Huawei vendor URC into a typed domain event.
 * Returns undefined if the URC is not a recognised Huawei event.
 */
export function interpretHuaweiURC(urc: URC): VendorEvent | undefined {
  if (urc.prefix === '^DSCI') return parseDsci(urc.body)

  if (urc.prefix === '^CEND') return parseCend(urc.body)

  const state = ORIG_CONF_CONN_STATE[urc.prefix]
  if (state !== undefined) {
    return {
      event: 'call:state',
      data: { state, direction: 'outgoing' },
    }
  }

  return undefined
}
