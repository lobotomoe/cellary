import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'send',
    description: 'Send an SMS message',
  },
  args: {
    number: {
      type: 'positional',
      description: 'Recipient phone number',
      required: true,
    },
    text: {
      type: 'positional',
      description: 'Message text',
      required: true,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const ref = await handle.sms.send(args.number, args.text)
        process.stdout.write(`Sent (ref: ${ref})\n`)
      })
    })
  },
})
