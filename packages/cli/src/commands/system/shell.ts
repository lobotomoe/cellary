import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'shell',
    description: 'Execute a shell command on the device (interactive if no command given)',
  },
  args: {
    command: {
      type: 'positional',
      description: 'Shell command to execute (omit for interactive shell)',
      required: false,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        if (args.command !== undefined && args.command !== '') {
          const output = await handle.system.shell(args.command)
          process.stdout.write(output)
          return
        }

        // Interactive shell
        if (handle.system.openInteractiveShell === undefined) {
          process.stderr.write('Interactive shell not available on this device\n')
          process.exitCode = 1
          return
        }

        const stream = await handle.system.openInteractiveShell()

        stream.onData((data: Buffer) => {
          process.stdout.write(data)
        })

        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true)
        }
        process.stdin.resume()

        process.stdin.on('data', (chunk: Buffer) => {
          stream.write(Buffer.from(chunk)).catch(() => {
            // Stream closed
          })
        })

        await new Promise<void>((resolve) => {
          stream.onClose(() => {
            if (process.stdin.isTTY) {
              process.stdin.setRawMode(false)
            }
            process.stdin.pause()
            resolve()
          })

          process.stdin.on('end', () => {
            stream.close()
          })
        })
      })
    })
  },
})
