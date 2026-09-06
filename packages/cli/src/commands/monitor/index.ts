import { defineCommand } from 'citty'
import { portArgs } from '../../lib/cli-args.js'
import { withErrorHandling } from '../../lib/errors.js'

export default defineCommand({
  meta: {
    name: 'up',
    description: 'Initialize modem and start interactive monitor',
  },
  args: {
    ...portArgs,
    detailed: {
      type: 'boolean',
      alias: 'd',
      description: 'Show detailed signal metrics (RSRP, SINR, band)',
      default: false,
    },
  },
  run({ args }) {
    return withErrorHandling(async () => {
      const { createBackend } = await import('../../backend/resolve.js')
      const backend = await createBackend()
      // Non-exclusive: the monitor is a long-lived live view. Holding an
      // exclusive lease would lock the device out of every other command for
      // the whole session; instead let other commands operate it concurrently.
      const handle = await backend.connect({
        target: args.port,
        verbose: args.verbose,
        exclusive: false,
      })
      try {
        const { renderMonitor } = await import('./app.js')
        await renderMonitor(handle, { verbose: args.detailed, backendMode: backend.mode })
      } finally {
        await handle.close()
        await backend.dispose()
      }
    })
  },
})
