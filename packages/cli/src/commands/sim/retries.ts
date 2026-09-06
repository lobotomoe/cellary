import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'retries',
    description: 'Show remaining PIN/PUK retry counts',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        if (handle.sim.pinRetries === undefined) {
          process.stdout.write('PIN retry counts not available on this device\n')
          return
        }

        const retries = await handle.sim.pinRetries()
        const parts = [`PIN1: ${retries.pin}  PUK1: ${retries.puk}`]

        if (retries.pin2 !== undefined) {
          parts.push(`  PIN2: ${retries.pin2}`)
        }
        if (retries.puk2 !== undefined) {
          parts.push(`  PUK2: ${retries.puk2}`)
        }

        process.stdout.write(`${parts.join('')}\n`)
      })
    })
  },
})
