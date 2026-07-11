import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'query',
    description: 'Query whether a facility is locked (e.g. SC, FD, PN)',
  },
  args: {
    facility: {
      type: 'positional',
      description: 'Facility code (e.g. "SC" for SIM PIN, "FD" for fixed dialling)',
      required: true,
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
        if (handle.sim.queryFacilityLock === undefined) {
          process.stdout.write('Facility lock query not available on this device\n')
          return
        }

        const serviceClass = args.class !== undefined ? Number(args.class) : undefined
        const locked = await handle.sim.queryFacilityLock(args.facility, serviceClass)
        const status = locked ? 'locked' : 'unlocked'
        process.stdout.write(`${args.facility}: ${status}\n`)
      })
    })
  },
})
