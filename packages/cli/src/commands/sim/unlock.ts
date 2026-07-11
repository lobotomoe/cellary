import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'unlock',
    description: 'Disable a facility lock (e.g. SC, FD, PN)',
  },
  args: {
    facility: {
      type: 'positional',
      description: 'Facility code (e.g. "SC" for SIM PIN, "FD" for fixed dialling)',
      required: true,
    },
    password: {
      type: 'string',
      description: 'Password/PIN required for the facility',
    },
    class: {
      type: 'string',
      description: 'Service class number (1=voice, 2=data, 4=fax)',
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        if (handle.sim.setFacilityLock === undefined) {
          process.stderr.write('Error: Facility lock not available on this device.\n')
          process.exit(1)
        }

        const serviceClass = args.class !== undefined ? Number(args.class) : undefined
        await handle.sim.setFacilityLock(args.facility, false, args.password, serviceClass)
        process.stdout.write(`${args.facility} unlocked\n`)
      })
    })
  },
})
