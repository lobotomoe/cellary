/**
 * `cellary daemon start` -- start the daemon process.
 *
 * By default, spawns `cellaryd` as a detached background process.
 * With --foreground, runs in the current terminal (useful for debugging).
 */

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDaemonRunning } from '@cellary/daemon/client'
import { defineCommand } from 'citty'

function findDaemonEntry(): string {
  const resolved = import.meta.resolve('@cellary/daemon')
  return fileURLToPath(resolved)
}

export default defineCommand({
  meta: {
    name: 'start',
    description: 'Start the cellary daemon',
  },
  args: {
    foreground: {
      type: 'boolean',
      alias: 'f',
      description: 'Run in foreground (do not detach)',
      default: false,
    },
  },
  async run({ args }) {
    const running = await isDaemonRunning()
    if (running) {
      process.stdout.write('Daemon is already running.\n')
      return
    }

    const entry = findDaemonEntry()

    if (args.foreground) {
      process.stdout.write('Starting daemon in foreground (Ctrl+C to stop)...\n')
      const child = spawn(process.execPath, [entry], {
        stdio: 'inherit',
        env: { ...process.env },
      })
      child.on('exit', (code) => process.exit(code ?? 1))
      return
    }

    // Detached background mode — redirect stdout/stderr to log file
    const logFd = openSync('/var/log/cellaryd.log', 'a')
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    })
    child.unref()

    process.stdout.write(`Daemon started (pid ${child.pid}).\n`)
  },
})
