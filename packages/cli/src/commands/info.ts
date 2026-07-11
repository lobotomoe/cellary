import type { ModemCapabilities, SmsCount } from 'cellary'
import { defineCommand } from 'citty'

import { withDevice } from '../backend/resolve.js'
import { withErrorHandling } from '../lib/errors.js'
import { findModemInterface } from '../lib/network-interface.js'
import { portArgs } from '../lib/resolve-modem.js'
import { formatSignalDetails, formatSignalMainLine } from '../lib/signal-format.js'

// Fixed label width for streaming output (longest label: "Interface" = 9 chars + 2 padding)
const LABEL_PAD = 11

function printLine(label: string, value: string): void {
  process.stdout.write(`${label.padEnd(LABEL_PAD)}${value}\n`)
}

function printError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Unknown error'
  process.stderr.write(`  ! ${label}: ${message}\n`)
}

export default defineCommand({
  meta: {
    name: 'info',
    description: 'Show modem overview (device, SIM, signal, network)',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        let anyOutput = false

        // ── Device ───────────────────────────────────────────────────────
        try {
          const d = await handle.device.info()
          const mfr = d.manufacturer ?? 'Unknown'
          // Prefer AT+CGMM response, fall back to USB database model name
          const model = d.model ?? handle.model?.name ?? 'Unknown'
          const rev = d.revision !== undefined ? ` (${d.revision})` : ''
          // Skip manufacturer prefix when model already contains it (e.g. "huawei" + "Huawei E8372")
          const modelContainsMfr = model.toLowerCase().startsWith(mfr.toLowerCase())
          const deviceName = modelContainsMfr ? model : `${mfr} ${model}`
          printLine('Device', `${deviceName}${rev}`)
          if (d.hardwareVersion !== undefined) printLine('Hardware', d.hardwareVersion)
          if (d.imei !== undefined) printLine('IMEI', d.imei)
          anyOutput = true
        } catch (err) {
          printError('Device', err)
        }

        // ── SIM ──────────────────────────────────────────────────────────
        try {
          const s = await handle.sim.info()
          const iccidLabel = s.iccid !== undefined ? s.iccid : 'N/A'
          printLine('SIM', `${iccidLabel} (${s.state})`)
          if (s.imsi !== undefined) printLine('IMSI', s.imsi)
          anyOutput = true
        } catch (err) {
          printError('SIM', err)
        }

        // ── Signal + Registration + Operator (parallel — all network) ────
        const [signalResult, regResult, operatorResult] = await Promise.allSettled([
          handle.network.signal(),
          handle.network.registration(),
          handle.network.operator(),
        ])

        if (signalResult.status === 'fulfilled') {
          const sig = signalResult.value
          const reg = regResult.status === 'fulfilled' ? regResult.value : undefined
          const tech = reg?.technology ?? sig.technology
          printLine('Signal', formatSignalMainLine(sig, tech))
          const details = formatSignalDetails(sig)
          if (details !== undefined) printLine('', details)
          anyOutput = true
        } else {
          printError('Signal', signalResult.reason)
        }

        if (regResult.status === 'fulfilled') {
          const r = regResult.value
          const main: string[] = [r.status]
          if (r.technology !== undefined) main.push(r.technology)
          let line = main.join(', ')
          const cellParts: string[] = []
          if (r.locationAreaCode !== undefined) cellParts.push(`LAC: ${r.locationAreaCode}`)
          if (r.cellId !== undefined) cellParts.push(`Cell: ${r.cellId}`)
          if (cellParts.length > 0) line += ` (${cellParts.join(', ')})`
          printLine('Network', line)
          anyOutput = true
        }

        if (operatorResult.status === 'fulfilled' && operatorResult.value !== undefined) {
          printLine('Operator', operatorResult.value)
          anyOutput = true
        } else if (operatorResult.status === 'rejected') {
          printError('Operator', operatorResult.reason)
        }

        // ── SMS ──────────────────────────────────────────────────────────
        try {
          const count = await handle.sms.count?.()
          if (count !== undefined) {
            printLine('SMS', formatSmsCountLine(count))
            anyOutput = true
          }
        } catch {
          // Non-critical
        }

        // ── Capabilities ───────────────────────────────────────────────────
        try {
          const caps = await handle.capabilities.discover()
          const lines = formatCapabilityLines(caps)
          if (lines.length > 0) {
            printLine('Features', lines[0] ?? '')
            for (let i = 1; i < lines.length; i++) {
              printLine('', lines[i] ?? '')
            }
            anyOutput = true
          }
        } catch {
          // Non-critical
        }

        // ── Interface ────────────────────────────────────────────────────
        const httpUrl = handle.httpUrl
        if (httpUrl !== undefined) {
          const gatewayIp = new URL(httpUrl).hostname
          const iface = findModemInterface(gatewayIp)
          if (iface !== undefined) {
            printLine('Interface', `${iface.name}  ${iface.address}`)
            anyOutput = true
          }
        }

        // ── Temperature ──────────────────────────────────────────────────
        try {
          const temp = await handle.device.temperature?.()
          if (temp !== undefined) {
            printLine('Temp', `${temp} C`)
            anyOutput = true
          }
        } catch {
          // Non-critical
        }

        if (!anyOutput) {
          process.stderr.write('Failed to retrieve modem information.\n')
          process.exit(1)
        }
      })
    })
  },
})

/** Extract names of true boolean fields. */
function booleanList(fields: Record<string, boolean>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value)
    .map(([name]) => name)
}

/**
 * Format capabilities as labeled lines for the info command.
 * Each line is "domain: feature1, feature2, ...".
 */
function formatCapabilityLines(caps: ModemCapabilities): string[] {
  const lines: string[] = []

  const sms = booleanList({
    send: caps.sms.send,
    receive: caps.sms.receive,
    read: caps.sms.read,
    delete: caps.sms.delete,
    multipart: caps.sms.multipart,
  })
  if (sms.length > 0) {
    const modes = caps.sms.modes.length > 0 ? ` (${caps.sms.modes.join(', ')})` : ''
    lines.push(`SMS: ${sms.join(', ')}${modes}`)
  }

  const voice = booleanList({
    dial: caps.voice.dial,
    answer: caps.voice.answer,
    hangup: caps.voice.hangup,
    dtmf: caps.voice.dtmf,
    forwarding: caps.voice.forwarding,
    waiting: caps.voice.waiting,
    hold: caps.voice.hold,
    'caller ID': caps.voice.callerId,
  })
  if (voice.length > 0) lines.push(`Voice: ${voice.join(', ')}`)

  const net = booleanList({
    signal: caps.network.signal,
    registration: caps.network.registration,
    'operator scan': caps.network.operatorScan,
    GPRS: caps.network.gprs,
    EPS: caps.network.eps,
  })
  if (net.length > 0) lines.push(`Network: ${net.join(', ')}`)

  if (caps.ussd.supported) lines.push('USSD: supported')
  if (caps.data.pdpContext) {
    const types = caps.data.types.length > 0 ? caps.data.types.join(', ') : 'PDP context'
    lines.push(`Data: ${types}`)
  }
  if (caps.stk.supported) lines.push('STK: supported')

  return lines
}

/** Format SMS count line: "3 unread / 45 inbox (500 max)" */
function formatSmsCountLine(count: SmsCount): string {
  const parts: string[] = []
  if (count.unread !== undefined) parts.push(`${count.unread} unread`)
  parts.push(`${count.inbox} inbox`)
  parts.push(`(${count.capacity} max)`)
  return parts.join(' / ')
}
