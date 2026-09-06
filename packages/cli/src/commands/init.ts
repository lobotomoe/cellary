import { createInterface } from 'node:readline'
import type { DiscoveredModem } from 'cellary'
import { defineCommand } from 'citty'

import { withBackend } from '../backend/resolve.js'
import { verboseArg } from '../lib/cli-args.js'
import { busLocation, deviceDisplayName, formatVidPid } from '../lib/device-format.js'
import { withErrorHandling } from '../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Initialize storage-mode devices (USB mode switch only, no monitor)',
  },
  args: {
    ...verboseArg,
    all: {
      type: 'boolean',
      description: 'Initialize all storage-mode devices',
      default: false,
    },
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withBackend(async (backend) => {
        const devices = await backend.listDevices()
        const storageDevices = devices.filter((d) => d.mode === 'storage')

        if (storageDevices.length === 0) {
          if (devices.length > 0) {
            process.stdout.write('All devices are already initialized.\n')
          } else {
            process.stdout.write('No modems found. Connect a modem and try again.\n')
          }
          return
        }

        let targets: DiscoveredModem[]

        if (args.all) {
          targets = storageDevices
        } else if (storageDevices.length === 1) {
          const only = storageDevices[0]
          if (only === undefined) return
          targets = [only]
        } else {
          // Multiple storage devices, no --all: prompt for selection
          process.stdout.write('Multiple storage-mode devices found:\n')
          for (let i = 0; i < storageDevices.length; i++) {
            const d = storageDevices[i]
            if (d === undefined) continue
            const ids = formatVidPid(d.vendorId, d.productId)
            process.stdout.write(`  ${i + 1}) ${deviceDisplayName(d)}  ${ids}  ${busLocation(d)}\n`)
          }
          process.stdout.write('  *) All devices\n')

          const answer = await promptInput('Select device [1]: ')
          const input = answer.trim() === '' ? '1' : answer.trim()

          if (input === '*' || input.toLowerCase() === 'all') {
            targets = storageDevices
          } else {
            const index = Number.parseInt(input, 10) - 1
            const selected = storageDevices[index]
            if (selected === undefined) {
              throw new Error(`Invalid selection: ${input}`)
            }
            targets = [selected]
          }
        }

        for (const target of targets) {
          const name = deviceDisplayName(target)
          const ids = formatVidPid(target.vendorId, target.productId)
          const bus = busLocation(target)

          process.stdout.write(`Initializing ${name} (${ids}, ${bus})...`)
          await backend.provision(target)
          process.stdout.write(' done\n')
        }

        const plural = targets.length > 1 ? 'devices' : 'device'
        process.stdout.write(`\n${targets.length} ${plural} ready.\n`)
      })
    })
  },
})

function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}
