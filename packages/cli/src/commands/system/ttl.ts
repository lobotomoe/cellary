import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

export default defineCommand({
  meta: {
    name: 'ttl',
    description: 'Read or set outgoing packet TTL',
  },
  args: {
    value: {
      type: 'positional',
      description: 'TTL value to set (1-255). Omit to read current.',
      required: false,
    },
    persist: {
      type: 'boolean',
      description: 'Persist the TTL rule across reboots',
      default: false,
    },
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const system = handle.system

        if (typeof args.value !== 'string' || args.value === '') {
          // Read mode
          if (system.getTtl === undefined) {
            process.stdout.write('TTL management not available on this device\n')
            return
          }
          const current = await system.getTtl()
          if (current === undefined) {
            process.stdout.write('No TTL rule set\n')
          } else {
            process.stdout.write(`Current TTL: ${current}\n`)
          }
          return
        }

        // Write mode
        if (system.setTtl === undefined) {
          process.stdout.write('TTL management not available on this device\n')
          return
        }

        const ttl = Number(args.value)
        await system.setTtl(ttl)
        process.stdout.write(`TTL set to ${ttl}\n`)

        if (args.persist) {
          if (system.persistTtl === undefined) {
            process.stdout.write('TTL management not available on this device\n')
            return
          }
          await system.persistTtl()
          process.stdout.write(`TTL ${ttl} persisted across reboots\n`)
        }
      })
    })
  },
})
