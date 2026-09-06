import { defineCommand } from 'citty'

import { withDevice } from '../../backend/resolve.js'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'
import { formatTable } from '../../lib/format.js'

function boolMark(value: boolean): string {
  return value ? 'yes' : ''
}

export default defineCommand({
  meta: {
    name: 'preferred',
    description: 'List, add, or remove preferred operators on the SIM',
  },
  args: {
    ...portArgs,
    add: {
      type: 'string',
      description: 'Add a preferred operator by PLMN code (MCC+MNC)',
    },
    remove: {
      type: 'string',
      description: 'Remove a preferred operator by index',
    },
    gsm: {
      type: 'boolean',
      description: 'Prefer GSM access technology',
      default: false,
    },
    utran: {
      type: 'boolean',
      description: 'Prefer UTRAN (3G) access technology',
      default: false,
    },
    eutran: {
      type: 'boolean',
      description: 'Prefer E-UTRAN (LTE) access technology',
      default: false,
    },
    index: {
      type: 'string',
      description: 'Index position for --add (1-based)',
    },
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        // --remove: delete an entry by index
        if (args.remove !== undefined) {
          const removeMethod = handle.network.removePreferredOperator
          if (removeMethod === undefined) {
            throw new Error('Preferred operator management not available on this device')
          }
          const removeIndex = Number(args.remove)
          if (!Number.isInteger(removeIndex) || removeIndex < 1) {
            throw new Error(`Invalid index: ${args.remove}. Must be a positive integer.`)
          }
          await removeMethod.call(handle.network, removeIndex)
          process.stdout.write(`Removed preferred operator at index ${removeIndex}\n`)
          return
        }

        // --add: add or update an entry
        if (args.add !== undefined) {
          const setMethod = handle.network.setPreferredOperator
          if (setMethod === undefined) {
            throw new Error('Preferred operator management not available on this device')
          }
          const plmn = args.add
          const entryIndex = args.index !== undefined ? Number(args.index) : 1
          if (!Number.isInteger(entryIndex) || entryIndex < 1) {
            throw new Error(`Invalid index: ${args.index}. Must be a positive integer.`)
          }
          await setMethod.call(handle.network, {
            index: entryIndex,
            numeric: plmn,
            gsm: args.gsm,
            utran: args.utran,
            eutran: args.eutran,
          })
          process.stdout.write(`Added preferred operator ${plmn} at index ${entryIndex}\n`)
          return
        }

        // Default: list all preferred operators
        const listMethod = handle.network.preferredOperators
        if (listMethod === undefined) {
          throw new Error('Preferred operator list not available on this device')
        }
        const operators = await listMethod.call(handle.network)

        if (operators.length === 0) {
          process.stdout.write('No preferred operators configured.\n')
          return
        }

        const headers = ['#', 'PLMN', 'GSM', 'UTRAN', 'E-UTRAN']
        const rows = operators.map((op) => [
          String(op.index),
          op.numeric,
          boolMark(op.gsm),
          boolMark(op.utran),
          boolMark(op.eutran),
        ])

        process.stdout.write(formatTable(headers, rows))
        process.stdout.write('\n')
      })
    })
  },
})
