/**
 * Interactive CLI prompts for modem selection.
 */

import { createInterface } from 'node:readline'
import type { DiscoveredModem } from 'cellary'

import { busLocation, deviceDisplayName, formatVidPid } from './device-format.js'

export async function promptModemSelection(
  modems: readonly DiscoveredModem[],
): Promise<DiscoveredModem> {
  process.stdout.write('Multiple modems found:\n')
  for (let i = 0; i < modems.length; i++) {
    const m = modems[i]
    if (m === undefined) continue
    process.stdout.write(`  ${i + 1}) ${formatModem(m)}\n`)
  }

  return promptSelection(modems)
}

function formatModem(m: DiscoveredModem): string {
  const name = deviceDisplayName(m)
  const ids = formatVidPid(m.vendorId, m.productId)
  const bus = busLocation(m)
  switch (m.mode) {
    case 'serial':
      return `${name}  ${m.path}  ${ids}`
    case 'modem-usb':
      return `${name}  ${ids}  ${bus}  (USB direct)`
    case 'http':
      return `${name}  ${ids}  ${bus}  (${m.url})`
    case 'storage':
      return `${name}  ${ids}  ${bus}  (needs mode switch)`
    case 'emergency':
      return `${name}  ${ids}  ${bus}  (BootROM)`
    case 'download':
      return `${name}  ${ids}  ${bus}  (download mode)`
  }
}

function promptSelection<T>(items: readonly T[]): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  return new Promise((resolve, reject) => {
    rl.question('Select modem [1]: ', (answer) => {
      rl.close()
      const input = answer.trim() === '' ? '1' : answer.trim()
      const index = Number.parseInt(input, 10) - 1
      const item = items[index]
      if (item === undefined) {
        reject(new Error(`Invalid selection: ${answer}`))
      } else {
        resolve(item)
      }
    })
  })
}
