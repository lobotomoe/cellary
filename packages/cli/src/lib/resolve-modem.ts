/**
 * Modem resolution for CLI commands.
 *
 * Resolution order (no sudo required unless USB fallback triggers):
 * 1. Port specified via --port: open directly
 * 2. discover() (prefers serial, no sudo): auto-detect
 * 3. If HTTP API or modem-usb found (may need sudo): Modem.detect()
 */

import type { ConnectionProgress, DiscoveredModem, Logger } from 'cellary'
import { discover, Modem } from 'cellary'

import { busLocation, deviceDisplayName, formatVidPid } from './device-format.js'
import { createLogger } from './logger.js'
import { confirmOrAbort, promptModemSelection } from './prompts.js'

/**
 * Progress callback for modem connection.
 * Only writes to stderr when there's something worth reporting (retries).
 * Stdout stays clean for command output.
 */
function onProgress(event: ConnectionProgress): void {
  if (event.attempt !== undefined && event.maxAttempts !== undefined) {
    process.stderr.write(`\r  ${event.message} (attempt ${event.attempt}/${event.maxAttempts})`)
  }
}

export interface ResolveModemOptions {
  /** Skip AT probe and init commands. Use for diagnostic/lenient modes. */
  readonly autoInit?: boolean | undefined
}

/**
 * Resolve and open a modem connection (read-only: no mode switching).
 *
 * Filters out devices in storage mode — those need explicit `cellary up`
 * before they can be used. This keeps read commands (info, signal, etc.)
 * free of side effects.
 *
 * Caller is responsible for closing the modem (use in try/finally).
 */
export async function resolveModem(
  port: string | undefined,
  verbose = false,
  options?: ResolveModemOptions,
): Promise<Modem> {
  const logger = createLogger(verbose)
  const autoInit = options?.autoInit

  if (port !== undefined) {
    return Modem.open({ path: port, logger, onProgress, autoInit })
  }

  const allModems = await discover()
  const operable = allModems.filter((m) => m.mode !== 'storage')

  if (operable.length === 0) {
    if (allModems.length > 0) {
      const lines = ['All devices are in storage mode (not ready):']
      for (const m of allModems) {
        lines.push(`  ${formatModem(m)}`)
      }
      lines.push('Run: sudo cellary init (or sudo cellary init --all)')
      throw new Error(lines.join('\n'))
    }
    throw new Error('No modem found. Connect a modem or specify --port.')
  }

  if (operable.length === 1) {
    const only = operable[0]
    if (only === undefined) throw new Error('Unexpected empty modems array')
    return openModem(only, logger, autoInit)
  }

  const selected = await promptModemSelection(operable)
  return openModem(selected, logger, autoInit)
}

/**
 * Resolve and open a modem, including mode switching if needed.
 *
 * Unlike resolveModem(), this accepts storage-mode devices and will prepare
 * them (USB vendor control transfer). Use for commands that explicitly
 * mutate device state (e.g. `cellary up`).
 */
export async function resolveModemWithPrepare(
  port: string | undefined,
  verbose = false,
): Promise<Modem> {
  const logger = createLogger(verbose)

  if (port !== undefined) {
    return Modem.open({ path: port, logger, onProgress })
  }

  const modems = await discover()

  if (modems.length === 0) {
    throw new Error('No modem found. Connect a modem or specify --port.')
  }

  const target = modems.length === 1 ? modems[0] : await promptModemSelection(modems)

  if (target === undefined) throw new Error('Unexpected empty modems array')

  if (target.mode === 'emergency' || target.mode === 'download') {
    const modeLabel =
      target.mode === 'emergency' ? 'BootROM (emergency)' : 'download (firmware flash)'
    throw new Error(
      `Device is in ${modeLabel} mode -- not a functional modem.\n` +
        'It must be restored to normal mode before it can be used.',
    )
  }

  if (target.mode === 'storage') {
    const name = deviceDisplayName(target)
    process.stdout.write(
      `Found ${name} in storage mode (${formatVidPid(target.vendorId, target.productId)}).\n` +
        'This will send a USB mode switch command to initialize the modem.\n',
    )
    await confirmOrAbort('Proceed?')
  }

  return Modem.detect(target, { logger, onProgress })
}

async function openModem(
  modem: DiscoveredModem,
  logger: Logger,
  autoInit?: boolean | undefined,
): Promise<Modem> {
  if (modem.mode === 'serial') {
    return Modem.open({ path: modem.path, logger, onProgress, autoInit })
  }
  return Modem.detect(modem, { logger, onProgress, autoInit })
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

/** --verbose / -v flag for debug logging (shared across all commands) */
export const verboseArg = {
  verbose: {
    type: 'boolean' as const,
    alias: 'v',
    description: 'Enable verbose logging to stderr',
    default: false,
  },
} as const

/** Shared arg definitions for modem-requiring commands */
export const portArgs = {
  port: {
    type: 'string' as const,
    alias: 'p',
    description: 'Serial port path (auto-detected if omitted)',
  },
  ...verboseArg,
} as const
