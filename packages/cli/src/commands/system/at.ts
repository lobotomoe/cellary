import { isAtAdapter } from 'cellary'
import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'at',
    description: 'Execute a raw AT command',
  },
  args: {
    command: {
      type: 'positional',
      description: 'AT command to execute (e.g. AT+CSQ)',
      required: true,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const system = handle.system

        // Preferred: a vendor internal AT bridge (e.g. AT tunneled through an ADB
        // shell on Linux/Android devices that expose no direct AT interface).
        if (system.executeAt !== undefined) {
          const response = await system.executeAt(args.command)
          process.stdout.write(response)
          return
        }

        // Fallback: the device's direct AT adapter (standard USB/serial modems).
        // Only available in direct mode -- the remote/daemon backend exposes no
        // raw adapter over IPC.
        const atAdapter = handle.rawAccess?.adapter('at')
        const at = isAtAdapter(atAdapter) ? atAdapter : undefined
        if (at !== undefined) {
          const result = await at.execute(args.command)
          const output = result.lines.length > 0 ? result.lines.join('\n') : 'OK'
          process.stdout.write(`${output}\n`)
          return
        }

        process.stdout.write(
          'No AT access on this device (no internal bridge, no direct AT adapter)\n',
        )
      })
    })
  },
})
