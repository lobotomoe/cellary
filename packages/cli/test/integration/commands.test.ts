/**
 * CLI command integration tests — runs against a real modem.
 *
 * Skipped automatically when no modem is connected.
 * Override auto-detection: MODEM_PORT=/dev/ttyUSB0 pnpm test:integration
 *
 * Run:
 *   pnpm -C packages/cli test:integration
 */

import { runCommand } from 'citty'
import { describe, expect, it } from 'vitest'

import { captureStdout, probeModem } from './helpers.js'

// Probe before any tests run (top-level await)
const probe = await probeModem()
const hasModem = probe !== undefined
const hasAtInterface = probe !== undefined && probe.modem.mode !== 'http'

// ── Device listing (no port arg needed) ────────────────────────────────────

describe.runIf(hasModem)('devices', () => {
  it('lists connected modems', async () => {
    const { default: devicesCommand } = await import('../../src/commands/devices.js')
    const output = await captureStdout(async () => {
      await runCommand(devicesCommand, { rawArgs: [] })
    })

    expect(output).not.toContain('No modems found')
    // Table should have at least one data row (header + device)
    const lines = output
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })
})

// ── Commands that take --port ──────────────────────────────────────────────

describe.runIf(hasModem)('CLI commands (real modem)', () => {
  // Serial modems carry an explicit port path; others auto-detect (no --port).
  const port = probe?.port
  const portRawArgs = port !== undefined ? ['--port', port] : []

  it('info — shows device overview', async () => {
    const { default: infoCommand } = await import('../../src/commands/info.js')
    const output = await captureStdout(async () => {
      await runCommand(infoCommand, { rawArgs: portRawArgs })
    })

    // Signal is always available regardless of protocol/auth
    expect(output).toContain('Signal')
  })

  it('signal — shows signal strength', async () => {
    const { default: signalCommand } = await import('../../src/commands/signal.js')
    const output = await captureStdout(async () => {
      await runCommand(signalCommand, { rawArgs: portRawArgs })
    })

    expect(output).toContain('dBm')
  })

  it.runIf(hasAtInterface)(
    'capabilities — discovers modem features',
    { timeout: 45_000 },
    async () => {
      const { default: capabilitiesCommand } = await import('../../src/commands/capabilities.js')
      const output = await captureStdout(async () => {
        await runCommand(capabilitiesCommand, { rawArgs: portRawArgs })
      })

      // All AT modems should have at least basic SMS and network capabilities
      expect(output).toContain('sms:')
      expect(output).toContain('network:')
    },
  )

  it('diagnose — runs voice diagnostics', async () => {
    const { default: diagnoseCommand } = await import('../../src/commands/diagnose.js')
    const output = await captureStdout(async () => {
      await runCommand(diagnoseCommand, { rawArgs: portRawArgs })
    })

    expect(output).toContain('Phone activity')
    expect(output).toContain('CS registration')
  })
})
