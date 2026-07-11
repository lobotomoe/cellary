/**
 * `cellary watch` -- live USB device observation.
 *
 * Starts a DeviceObserver with all built-in resolvers and prints
 * events as they happen: appearances, detaches, state changes,
 * boot-loop detection, mode-switch tracking, etc.
 */

import type { DeviceSessionSnapshot, DeviceStateAnalysis } from 'cellary'
import { defineCommand } from 'citty'

import { createBackend } from '../backend/resolve.js'
import { withErrorHandling } from '../lib/errors.js'
import { hex4 } from '../lib/format.js'

// -- Formatting helpers ------------------------------------------------------

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

function severityTag(severity: string): string {
  switch (severity) {
    case 'critical':
      return '[!!]'
    case 'degraded':
      return '[!]'
    default:
      return '[ok]'
  }
}

function formatPid(pid: number | undefined): string {
  return pid !== undefined ? `0x${hex4(pid)}` : '----'
}

function formatSession(session: DeviceSessionSnapshot): string {
  const parts = [session.vendorName]
  if (session.currentCycle !== undefined) {
    parts.push(`PID ${formatPid(session.currentCycle.pid)}`)
  }
  if (session.completedCycleCount > 0) {
    parts.push(`${session.completedCycleCount} cycle(s)`)
  }
  if (session.avgOnBusDurationMs !== undefined) {
    parts.push(`avg on: ${fmtMs(session.avgOnBusDurationMs)}`)
  }
  if (session.avgOffBusDurationMs !== undefined) {
    parts.push(`avg off: ${fmtMs(session.avgOffBusDurationMs)}`)
  }
  return parts.join('  ')
}

function formatAnalysis(analysis: DeviceStateAnalysis): string {
  const parts = [`${severityTag(analysis.severity)} ${analysis.state}: ${analysis.description}`]
  if (analysis.recommendations.length > 0) {
    for (const rec of analysis.recommendations) {
      parts.push(`    ${rec}`)
    }
  }
  if (analysis.expectedNextPid !== undefined) {
    parts.push(`  Expected next PID: ${formatPid(analysis.expectedNextPid)}`)
  }
  if (analysis.estimatedRecoveryMs !== undefined) {
    parts.push(`  Estimated recovery: ${fmtMs(analysis.estimatedRecoveryMs)}`)
  }
  return parts.join('\n')
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

// -- Command -----------------------------------------------------------------

export default defineCommand({
  meta: {
    name: 'watch',
    description: 'Watch USB bus for modem events (live)',
  },
  args: {},
  run() {
    return withErrorHandling(async () => {
      const backend = await createBackend()
      const watcher = backend.createWatcher()

      watcher.on('device:appeared', (session, analysis) => {
        process.stdout.write(`[${ts()}] +++ APPEARED  ${formatSession(session)}\n`)
        process.stdout.write(`  ${formatAnalysis(analysis)}\n\n`)
      })

      watcher.on('device:attached', (session, analysis) => {
        process.stdout.write(`[${ts()}] +   ATTACHED  ${formatSession(session)}\n`)
        process.stdout.write(`  ${formatAnalysis(analysis)}\n\n`)
      })

      watcher.on('device:detached', (session, analysis) => {
        process.stdout.write(`[${ts()}] -   DETACHED  ${formatSession(session)}\n`)
        process.stdout.write(`  ${formatAnalysis(analysis)}\n\n`)
      })

      watcher.on('device:state-changed', (session, analysis, previous) => {
        process.stdout.write(
          `[${ts()}] *   STATE     ${formatSession(session)}\n` +
            `  ${previous.state} -> ${analysis.state}\n` +
            `  ${formatAnalysis(analysis)}\n\n`,
        )
      })

      watcher.on('device:gone', (session) => {
        process.stdout.write(`[${ts()}] x   GONE      ${session.vendorName} (offline > 5 min)\n\n`)
      })

      process.stdout.write(`[${ts()}] Watching USB bus for modem events...\n`)
      process.stdout.write('Press Ctrl+C to stop.\n\n')

      watcher.start()

      // Keep alive until Ctrl+C
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          process.stdout.write(`\n[${ts()}] Stopped.\n`)
          watcher.dispose()
          backend.dispose().catch(() => {})
          resolve()
        })
      })
    })
  },
})
