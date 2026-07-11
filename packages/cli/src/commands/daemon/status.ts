/**
 * `cellary daemon status` -- show daemon status.
 *
 * Connects to the daemon and queries `daemon.status` RPC.
 */

import { DaemonClient, isDaemonRunning } from '@cellary/daemon/client'
import { defineCommand } from 'citty'

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export default defineCommand({
  meta: {
    name: 'status',
    description: 'Show cellary daemon status',
  },
  async run() {
    const running = await isDaemonRunning()
    if (!running) {
      process.stdout.write('Daemon is not running.\n')
      process.stdout.write('  Start with: cellary daemon start\n')
      return
    }

    const client = new DaemonClient()
    try {
      await client.connect()
      const status = await client.status()

      process.stdout.write(`Daemon running (pid ${status.pid})\n`)
      process.stdout.write(`  Version:  ${status.version}\n`)
      process.stdout.write(`  Uptime:   ${formatUptime(status.uptime)}\n`)
      process.stdout.write(`  Devices:  ${status.deviceCount}\n`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      process.stderr.write(`Failed to query daemon: ${message}\n`)
      process.exit(1)
    } finally {
      client.disconnect()
    }
  },
})
