import { defineCommand } from 'citty'

import { withDevice } from '../backend/resolve.js'
import { withErrorHandling } from '../lib/errors.js'
import { portArgs } from '../lib/resolve-modem.js'
import { formatSignalDetails, formatSignalMainLine, signalBars } from '../lib/signal-format.js'

export default defineCommand({
  meta: {
    name: 'signal',
    description: 'Show signal strength',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const signal = await handle.network.signal()
        const reg = await handle.network.registration()

        const tech = reg.technology ?? signal.technology
        const bars = signalBars(signal.rssi)
        const mainLine = formatSignalMainLine(signal, tech)

        process.stdout.write(`${bars}  ${mainLine}`)
        process.stdout.write('\n')

        const details = formatSignalDetails(signal)
        if (details !== undefined) {
          // Indent to align with the signal value (after bars + gap)
          const indent = ' '.repeat(bars.length + 2)
          process.stdout.write(`${indent}${details}\n`)
        }
      })
    })
  },
})
