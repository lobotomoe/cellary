import { defineCommand } from 'citty'
import { withErrorHandling } from '../../lib/errors.js'
import { portArgs } from '../../lib/resolve-modem.js'

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
      const handle = await backend.connect({ target: args.port, verbose: args.verbose })
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
