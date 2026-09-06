import { isAtAdapter } from 'cellary'
import { defineCommand } from 'citty'
import { withDevice } from '../backend/resolve.js'
import { CF_REASON, MS_CLASS, PHONE_ACTIVITY } from '../lib/3gpp-tables.js'
import { portArgs } from '../lib/cli-args.js'
import { withErrorHandling } from '../lib/errors.js'
import { formatLabels } from '../lib/format.js'
import { formatSignalDetails, formatSignalMainLine } from '../lib/signal-format.js'

// +CLIP: <n>[,<m>]  -- second group optional (network provision status)
const CLIP_REGEX = /\+CLIP:\s*(\d+)(?:,(\d+))?/

// +CCFC: <status>,<class>[,"<number>",<type>]
const CCFC_REGEX = /\+CCFC:\s*(\d+),(\d+)(?:,"([^"]*)")?/

// +CGCLASS: "<class>"
const CGCLASS_REGEX = /\+CGCLASS:\s*"([^"]+)"/

/** Timeout for service calls that may hit a dead adapter. */
const SERVICE_TIMEOUT_MS = 5_000

export default defineCommand({
  meta: {
    name: 'diagnose',
    description: 'Full diagnostics: device, SIM, network, voice, call forwarding',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice(
        { target: args.port, verbose: args.verbose, autoInit: false },
        async (handle) => {
          // ── Connection ────────────────────────────────────────────────────
          progress('Probing AT channel')
          const connPairs: [string, string][] = []
          connPairs.push(['Protocols', handle.protocols.join(', ') || 'none'])

          // Single AT probe with short timeout (not the full 3-retry init)
          const atAdapter = handle.rawAccess?.adapter('at')
          const at = isAtAdapter(atAdapter) ? atAdapter : undefined
          let atAvailable = false
          if (at !== undefined) {
            try {
              await at.execute('AT', { timeout: 3_000 })
              atAvailable = true
              connPairs.push(['AT channel', 'responsive'])
            } catch {
              connPairs.push(['AT channel', 'not responding'])
            }
          }

          const httpUrl = handle.httpUrl
          if (httpUrl !== undefined) {
            connPairs.push(['HTTP API', httpUrl])
          }

          printSection('Connection', connPairs)

          // ── Device ────────────────────────────────────────────────────────
          progress('Querying device info')
          const devPairs: [string, string][] = []
          try {
            const info = await withTimeout(handle.device.info(), SERVICE_TIMEOUT_MS)
            const model = info.model ?? 'Unknown'
            const rev = info.revision !== undefined ? ` (${info.revision})` : ''
            const mfr = info.manufacturer ?? 'Unknown'
            devPairs.push(['Device', `${mfr} ${model}${rev}`])
            if (info.hardwareVersion !== undefined)
              devPairs.push(['Hardware', info.hardwareVersion])
            if (info.imei !== undefined) devPairs.push(['IMEI', info.imei])
          } catch {
            devPairs.push(['Device', 'not available'])
          }

          try {
            const temp = await withTimeout(
              handle.device.temperature?.() ?? Promise.resolve(undefined),
              SERVICE_TIMEOUT_MS,
            )
            if (temp !== undefined) devPairs.push(['Temperature', `${temp} C`])
          } catch {
            // Optional
          }

          printSection('Device', devPairs)

          // ── SIM ───────────────────────────────────────────────────────────
          progress('Querying SIM')
          const simPairs: [string, string][] = []
          try {
            const info = await withTimeout(handle.sim.info(), SERVICE_TIMEOUT_MS)
            simPairs.push(['SIM state', info.state])
            if (info.iccid !== undefined) simPairs.push(['ICCID', info.iccid])
            if (info.imsi !== undefined) {
              const mcc = info.imsi.slice(0, 3)
              const mnc = info.imsi.slice(3, 5)
              simPairs.push(['IMSI', `${info.imsi} (MCC ${mcc} MNC ${mnc})`])
            }
            if (info.operator !== undefined) simPairs.push(['SIM operator', info.operator])
          } catch {
            simPairs.push(['SIM', 'not available'])
          }

          try {
            const phone = await withTimeout(
              handle.sim.phoneNumber?.() ?? Promise.resolve(undefined),
              SERVICE_TIMEOUT_MS,
            )
            if (phone !== undefined) simPairs.push(['MSISDN', phone])
          } catch {
            // Optional
          }

          printSection('SIM', simPairs)

          // ── Network ───────────────────────────────────────────────────────
          progress('Querying network')
          const netPairs: [string, string][] = []
          try {
            const reg = await withTimeout(handle.network.registration(), SERVICE_TIMEOUT_MS)
            const parts: string[] = [reg.status]
            if (reg.technology !== undefined) parts.push(reg.technology)
            let line = parts.join(', ')
            const cellParts: string[] = []
            if (reg.locationAreaCode !== undefined) cellParts.push(`LAC: ${reg.locationAreaCode}`)
            if (reg.cellId !== undefined) cellParts.push(`Cell: ${reg.cellId}`)
            if (cellParts.length > 0) line += ` (${cellParts.join(', ')})`
            netPairs.push(['Registration', line])
          } catch {
            netPairs.push(['Registration', 'not available'])
          }

          try {
            const signal = await withTimeout(handle.network.signal(), SERVICE_TIMEOUT_MS)
            netPairs.push(['Signal', formatSignalMainLine(signal)])
            const details = formatSignalDetails(signal)
            if (details !== undefined) netPairs.push(['', details])
          } catch {
            netPairs.push(['Signal', 'not available'])
          }

          try {
            const op = await withTimeout(
              handle.network.operator() ?? Promise.resolve(undefined),
              SERVICE_TIMEOUT_MS,
            )
            if (op !== undefined) netPairs.push(['Operator', op])
          } catch {
            // Optional
          }

          printSection('Network', netPairs)

          // ── Voice / AT (only when AT is responsive) ───────────────────────
          // Safe AT probe: returns response lines, empty array on timeout/error
          async function probe(cmd: string): Promise<readonly string[]> {
            if (!atAvailable || at === undefined) return []
            try {
              const result = await at.execute(cmd)
              return result.lines
            } catch {
              return []
            }
          }

          function raw(lines: readonly string[]): string {
            if (lines.length === 0) return 'no response'
            return lines.join(' | ')
          }

          if (atAvailable) {
            progress('Probing voice / call forwarding')
            const voicePairs: [string, string][] = []

            // Phone activity
            const cpasLines = await probe('AT+CPAS')
            const cpasMatch = /\+CPAS:\s*(\d+)/.exec(cpasLines[0] ?? '')
            if (cpasMatch) {
              const [, code] = cpasMatch
              voicePairs.push([
                'Phone activity',
                code !== undefined ? (PHONE_ACTIVITY[code] ?? `code ${code}`) : 'unknown',
              ])
            }

            // CLIP
            const clipLines = await probe('AT+CLIP?')
            const clipMatch = CLIP_REGEX.exec(clipLines[0] ?? '')
            if (clipMatch) {
              const [, n, m] = clipMatch
              const modemEnabled = n === '1' ? 'enabled on modem' : 'disabled on modem'
              let netSupport = 'network does not support'
              if (m === undefined) netSupport = 'network status unknown'
              else if (m === '1') netSupport = 'network supports'
              voicePairs.push(['CLIP', `${modemEnabled}, ${netSupport}`])
            }

            // MS class
            const cgclassLines = await probe('AT+CGCLASS?')
            const cgclassMatch = CGCLASS_REGEX.exec(cgclassLines[0] ?? '')
            if (cgclassMatch) {
              const [, cls] = cgclassMatch
              voicePairs.push(['MS class', cls !== undefined ? (MS_CLASS[cls] ?? cls) : 'unknown'])
            }

            // Call forwarding
            for (const reason of [0, 1, 2, 3]) {
              const label = CF_REASON[String(reason)] ?? `reason ${reason}`
              const cfLines = await probe(`AT+CCFC=${reason},2`)

              let relevantLine: string | undefined
              for (const line of cfLines) {
                const m = CCFC_REGEX.exec(line)
                if (m !== null && (m[2] === '1' || m[2] === '255')) {
                  relevantLine = line
                  break
                }
              }

              if (relevantLine !== undefined) {
                const m = CCFC_REGEX.exec(relevantLine)
                if (m !== null) {
                  const [, status, , number] = m
                  const active = status === '1' ? 'active' : 'inactive'
                  const dest = number !== undefined && number !== '' ? ` -> ${number}` : ''
                  voicePairs.push([`CF ${label}`, `${active}${dest}`])
                }
              } else if (cfLines.some((l) => l.startsWith('+CCFC'))) {
                voicePairs.push([`CF ${label}`, raw(cfLines)])
              } else {
                voicePairs.push([`CF ${label}`, cfLines.length === 0 ? 'inactive' : raw(cfLines)])
              }
            }

            // Active calls
            const clccLines = await probe('AT+CLCC')
            const hasActiveCalls = clccLines.some((l) => l.startsWith('+CLCC'))
            voicePairs.push(['Active calls', hasActiveCalls ? clccLines.join('; ') : 'none'])

            printSection('Voice / AT', voicePairs)
          }

          // ── Vendor ────────────────────────────────────────────────────────
          if (handle.plugin?.diagnose !== undefined) {
            progress('Running vendor diagnostics')
            const vendorPairs = await handle.plugin.diagnose(probe)
            if (vendorPairs.length > 0) {
              printSection('Vendor', [...vendorPairs])
            }
          }

          clearProgress()
          process.stdout.write('\n')
        },
      )
    })
  },
})

// ── Output helpers ──────────────────────────────────────────────────────────

/** Overwritable progress line on stderr. */
function progress(message: string): void {
  process.stderr.write(`\r\x1b[K  ... ${message}`)
}

/** Clear the progress line. */
function clearProgress(): void {
  process.stderr.write('\r\x1b[K')
}

/** Print a titled section with indented label-value pairs. */
function printSection(title: string, pairs: readonly [string, string][]): void {
  if (pairs.length === 0) return
  clearProgress()
  const formatted = formatLabels(pairs)
  const indented = formatted
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
  process.stdout.write(`\n  ${title}\n${indented}\n`)
}

/** Race a promise against a timeout. Rejects with Error on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
