/**
 * `cellary daemon stop` -- stop the running daemon.
 *
 * Connects to the daemon and sends `daemon.shutdown` RPC.
 * If the daemon doesn't exit within 5 seconds, kills it by PID.
 */

import { execSync } from 'node:child_process'

import { DaemonClient, isDaemonRunning } from '@cellary/daemon/client'
import { defineCommand } from 'citty'

const SHUTDOWN_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 200

function findDaemonPid(): number | undefined {
  try {
    const output = execSync('pgrep -f "packages/daemon/dist/main.js"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    const pid = Number.parseInt(output.split('\n')[0] ?? '', 10)
    return Number.isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

export default defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the running cellary daemon',
  },
  async run() {
    const running = await isDaemonRunning()
    if (!running) {
      // Socket not responding, but process might be stuck
      const pid = findDaemonPid()
      if (pid !== undefined) {
        process.stdout.write(`Daemon not responding, killing PID ${pid}...\n`)
        process.kill(pid, 'SIGTERM')
        const exited = await waitForExit(pid, SHUTDOWN_TIMEOUT_MS)
        if (!exited) {
          process.kill(pid, 'SIGKILL')
        }
        process.stdout.write('Daemon stopped.\n')
        return
      }
      process.stdout.write('Daemon is not running.\n')
      return
    }

    const pid = findDaemonPid()

    // Try graceful RPC shutdown first
    const client = new DaemonClient()
    try {
      await client.connect()
      await client.shutdown()
    } catch {
      // RPC failed, fall through to kill
    } finally {
      client.disconnect()
    }

    // Verify daemon actually exited
    if (pid !== undefined) {
      const exited = await waitForExit(pid, SHUTDOWN_TIMEOUT_MS)
      if (!exited) {
        process.stdout.write('Daemon did not exit gracefully, killing...\n')
        process.kill(pid, 'SIGKILL')
      }
    }

    process.stdout.write('Daemon stopped.\n')
  },
})
