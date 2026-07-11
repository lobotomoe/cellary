import type { RegistrationInfo } from 'cellary'
import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

const STATUS_LABELS: Record<string, string> = {
  notRegistered: 'not registered',
  home: 'registered',
  searching: 'searching',
  denied: 'denied',
  unknown: 'unknown',
  roaming: 'roaming',
}

function formatRegistration(info: RegistrationInfo): string {
  const parts: string[] = []

  const label = STATUS_LABELS[info.status] ?? info.status
  parts.push(label)

  if (info.technology !== undefined) {
    parts.push(info.technology)
  }

  const details: string[] = []
  if (info.locationAreaCode !== undefined) {
    // EPS uses TAC (Tracking Area Code), CS uses LAC (Location Area Code)
    // Both come through locationAreaCode field
    details.push(`LAC: ${info.locationAreaCode}`)
  }
  if (info.cellId !== undefined) {
    details.push(`Cell: ${info.cellId}`)
  }

  if (details.length > 0) {
    parts.push(`(${details.join(', ')})`)
  }

  return parts.join(', ')
}

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show network registration status (CS, EPS, GPRS)',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        // CS registration is always available
        const csPromise = handle.network.registration()

        // EPS and GPRS are optional — use allSettled
        const epsMethod = handle.network.epsRegistration
        const gprsMethod = handle.network.gprsRegistration

        const optionalPromises = [
          epsMethod !== undefined
            ? epsMethod.call(handle.network)
            : Promise.reject(new Error('not available')),
          gprsMethod !== undefined
            ? gprsMethod.call(handle.network)
            : Promise.reject(new Error('not available')),
        ]

        const [csResult, optionalResults] = await Promise.all([
          csPromise,
          Promise.allSettled(optionalPromises),
        ])

        const epsResult = optionalResults[0]
        const gprsResult = optionalResults[1]

        // CS is always shown
        process.stdout.write(`CS   ${formatRegistration(csResult)}\n`)

        // EPS — only show if method exists and succeeded
        if (epsResult !== undefined && epsResult.status === 'fulfilled') {
          // For EPS, LAC is actually TAC
          const formatted = formatRegistration(epsResult.value).replace('LAC:', 'TAC:')
          process.stdout.write(`EPS  ${formatted}\n`)
        }

        // GPRS — only show if method exists and succeeded
        if (gprsResult !== undefined && gprsResult.status === 'fulfilled') {
          process.stdout.write(`GPRS ${formatRegistration(gprsResult.value)}\n`)
        }
      })
    })
  },
})
