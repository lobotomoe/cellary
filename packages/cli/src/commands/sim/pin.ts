import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'pin',
    description: 'Enter SIM PIN code',
  },
  args: {
    code: {
      type: 'positional',
      description: 'PIN code',
      required: true,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        try {
          await handle.sim.enterPin(args.code)
          process.stdout.write('SIM unlocked\n')
        } catch (error: unknown) {
          if (handle.sim.pinRetries !== undefined) {
            const retries = await handle.sim.pinRetries()
            process.stderr.write(`PIN entry failed. Remaining attempts: PIN1=${retries.pin}\n`)
          }
          throw error
        }
      })
    })
  },
})
