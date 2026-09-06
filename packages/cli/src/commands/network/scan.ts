import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'
import { formatTable } from '../../lib/format.js'

export default defineCommand({
  meta: {
    name: 'scan',
    description: 'Scan for available network operators (slow: 30-120s)',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        process.stdout.write('Scanning operators (this may take up to 2 minutes)...\n')
        const networks = await handle.scanNetworks()

        if (networks.length === 0) {
          process.stdout.write('No operators found.\n')
          return
        }

        const headers = ['Status', 'Operator', 'Short', 'PLMN', 'Technology']
        const rows = networks.map((n) => [
          n.status,
          n.name ?? '',
          n.shortName ?? '',
          n.numeric,
          n.technology ?? '',
        ])

        process.stdout.write(formatTable(headers, rows))
        process.stdout.write('\n')
      })
    })
  },
})
