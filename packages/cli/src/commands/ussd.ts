import { defineCommand } from 'citty'

import { withDevice } from '../backend/resolve.js'
import { withErrorHandling } from '../lib/errors.js'
import { portArgs } from '../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'ussd',
    description: 'Send a USSD code (e.g. "*100#") and print the network reply',
  },
  args: {
    code: {
      type: 'positional',
      description: 'USSD code to send, e.g. "*100#"',
      required: true,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      // One-shot: each invocation opens and closes its own connection, so a
      // USSD session cannot span commands. This sends a single code and prints
      // the reply -- ideal for balance/info codes. Interactive menu flows belong
      // in the live monitor (`cellary up`), where the session stays open.
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const reply = await handle.ussd.send(args.code)
        process.stdout.write(`${reply}\n`)
      })
    })
  },
})
