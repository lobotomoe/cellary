import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'select',
    description: 'Manually select a network by PLMN code',
  },
  args: {
    ...portArgs,
    plmn: {
      type: 'positional' as const,
      description: 'PLMN code (MCC+MNC), e.g. 28301',
      required: true,
    },
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        await handle.selectNetwork(args.plmn)
        process.stdout.write(`Selected operator ${args.plmn}\n`)
      })
    })
  },
})
