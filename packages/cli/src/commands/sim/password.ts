import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'password',
    description: 'Change a facility password (e.g. SIM PIN, call barring)',
  },
  args: {
    facility: {
      type: 'positional',
      description: 'Facility code (e.g. "SC" for SIM PIN, "P2" for PIN2)',
      required: true,
    },
    old: {
      type: 'positional',
      description: 'Current password',
      required: true,
    },
    new: {
      type: 'positional',
      description: 'New password',
      required: true,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        if (handle.sim.changePassword === undefined) {
          process.stderr.write('Error: Password change not available on this device.\n')
          process.exit(1)
        }

        await handle.sim.changePassword(args.facility, args.old, args.new)
        process.stdout.write(`Password changed for ${args.facility}\n`)
      })
    })
  },
})
