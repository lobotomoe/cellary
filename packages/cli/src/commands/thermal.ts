import { defineCommand } from 'citty'

import { withDevice } from '../backend/resolve.js'
import { portArgs } from '../lib/cli-args.js'
import { withErrorHandling } from '../lib/errors.js'

function mhz(khz: number): string {
  return `${Math.round(khz / 1000)} MHz`
}

export default defineCommand({
  meta: {
    name: 'thermal',
    description: 'Show temperature sensors and CPU frequency',
  },
  args: {
    ...portArgs,
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withDevice({ target: args.port, verbose: args.verbose }, async (handle) => {
        const sensors = await handle.thermal.readSensors()
        const cpu = await handle.thermal.readCpuFrequency()

        process.stdout.write('Temperature\n')
        if (sensors.length === 0) {
          process.stdout.write('  (no sensors reported)\n')
        } else {
          const width = Math.max(...sensors.map((s) => s.sensor.length))
          for (const { sensor, celsius } of sensors) {
            process.stdout.write(`  ${sensor.padEnd(width)}  ${celsius.toFixed(1)} °C\n`)
          }
        }

        process.stdout.write('\nCPU frequency\n')
        process.stdout.write(`  max        ${mhz(cpu.maxKhz)}\n`)
        if (cpu.currentKhz !== undefined) {
          process.stdout.write(`  current    ${mhz(cpu.currentKhz)}\n`)
        }
        const available = cpu.availableKhz.map(mhz).join(' / ')
        process.stdout.write(`  available  ${available}\n`)
      })
    })
  },
})
