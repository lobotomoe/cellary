import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { formatTable } from '../../lib/format.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'operators',
    description: 'List operator names from modem firmware database',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const namesMethod = handle.network.operatorNames
        if (namesMethod === undefined) {
          process.stdout.write('Operator name database not available on this device.\n')
          return
        }

        const entries = await namesMethod.call(handle.network)

        if (entries.length === 0) {
          process.stdout.write('Operator name database is empty.\n')
          return
        }

        const headers = ['PLMN', 'Name']
        const rows = entries.map((entry) => [entry.numeric, entry.name])

        process.stdout.write(formatTable(headers, rows))
        process.stdout.write('\n')
      })
    })
  },
})
