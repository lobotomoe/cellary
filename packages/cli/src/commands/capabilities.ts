import type { ModemCapabilities } from 'cellary'
import { defineCommand } from 'citty'

import { withDevice } from '../backend/resolve.js'
import { portArgs } from '../lib/cli-args.js'
import { withErrorHandling } from '../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'capabilities',
    description: 'Discover modem capabilities',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const caps = await handle.capabilities.discover()
        process.stdout.write(formatCapabilities(caps))
        process.stdout.write('\n')
      })
    })
  },
})

// ── Formatting ──────────────────────────────────────────────────────────────

function formatCapabilities(caps: ModemCapabilities): string {
  const sections: string[] = []

  // SMS
  const smsFeatures = booleanList({
    send: caps.sms.send,
    receive: caps.sms.receive,
    read: caps.sms.read,
    delete: caps.sms.delete,
    multipart: caps.sms.multipart,
  })
  if (smsFeatures.length > 0) {
    let line = `sms:         ${smsFeatures.join(', ')}`
    if (caps.sms.modes.length > 0) {
      line += ` (modes: ${caps.sms.modes.join(', ')})`
    }
    sections.push(line)
  }

  // Voice
  const voiceFeatures = booleanList({
    dial: caps.voice.dial,
    answer: caps.voice.answer,
    hangup: caps.voice.hangup,
    dtmf: caps.voice.dtmf,
    forwarding: caps.voice.forwarding,
    waiting: caps.voice.waiting,
    hold: caps.voice.hold,
    'caller ID': caps.voice.callerId,
  })
  if (voiceFeatures.length > 0) {
    sections.push(`voice:       ${voiceFeatures.join(', ')}`)
  }

  // Network
  const networkFeatures = booleanList({
    signal: caps.network.signal,
    registration: caps.network.registration,
    'operator scan': caps.network.operatorScan,
    GPRS: caps.network.gprs,
    EPS: caps.network.eps,
  })
  if (networkFeatures.length > 0) {
    sections.push(`network:     ${networkFeatures.join(', ')}`)
  }

  // SIM
  const simFeatures = booleanList({
    IMSI: caps.sim.imsi,
    ICCID: caps.sim.iccid,
    PIN: caps.sim.pin,
    phonebook: caps.sim.phonebook,
  })
  if (simFeatures.length > 0) {
    sections.push(`sim:         ${simFeatures.join(', ')}`)
  }

  // USSD
  if (caps.ussd.supported) {
    sections.push('ussd:        supported')
  }

  // Data
  if (caps.data.pdpContext) {
    const typesStr = caps.data.types.length > 0 ? caps.data.types.join(', ') : 'PDP context'
    sections.push(`data:        ${typesStr}`)
  }

  // STK
  if (caps.stk.supported) {
    sections.push('stk:         supported')
  }

  if (sections.length === 0) {
    return 'No capabilities detected (AT+CLAC may not be supported).'
  }

  return sections.join('\n')
}

/** Extract names of true boolean fields */
function booleanList(fields: Record<string, boolean>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value)
    .map(([name]) => name)
}
