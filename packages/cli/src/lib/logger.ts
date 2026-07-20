/**
 * CLI logger factory.
 *
 * Wraps pino into the core Logger interface so library code gets structured
 * logging without depending on pino directly.
 *
 * File logging (JSON lines in `logs/`) is always active — every CLI run
 * produces a log file for post-mortem analysis. Log files are gitignored.
 * The file log defaults to `info`; --verbose raises it to `trace` and also
 * mirrors pretty-printed trace output to stderr. Detailed device traffic
 * belongs in the durable device-comms audit, not the app log.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Logger } from 'cellary'
import pino from 'pino'

/**
 * Resolve the directory for log files.
 *
 * In development (monorepo): logs/ at the workspace root.
 * When installed globally or run from outside the repo: logs/ in cwd.
 */
function resolveLogDir(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return resolve(dir, 'logs')
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(process.cwd(), 'logs')
}

const LOGS_DIR = resolveLogDir()

function wrapPino(instance: pino.Logger): Logger {
  return {
    trace(msg, data) {
      instance.trace(data ?? {}, msg)
    },
    debug(msg, data) {
      instance.debug(data ?? {}, msg)
    },
    info(msg, data) {
      instance.info(data ?? {}, msg)
    },
    warn(msg, data) {
      instance.warn(data ?? {}, msg)
    },
    error(msg, data) {
      instance.error(data ?? {}, msg)
    },
    child(bindings) {
      return wrapPino(instance.child(bindings))
    },
  }
}

function buildLogFilePath(): string {
  mkdirSync(LOGS_DIR, { recursive: true })
  const now = new Date()
  const stamp = now.toISOString().slice(0, 19).replace(/[T:]/g, '-')
  return resolve(LOGS_DIR, `${stamp}.log`)
}

/**
 * Default file-log level. Detailed device traffic (trace) is opt-in via
 * --verbose; by default the app log stays at info so we don't persist AT
 * traffic to disk on every run.
 */
const DEFAULT_FILE_LEVEL: pino.Level = 'info'
const VERBOSE_LEVEL: pino.Level = 'trace'

/**
 * Build the pino transport config for the CLI logger.
 *
 * Without verbose: a single JSON file target at info.
 * With verbose: the file target is raised to trace, plus a pretty stderr mirror.
 *
 * Exported for unit-testing the level policy without spinning up pino.
 */
export function buildLogTransport(
  verbose: boolean,
  logFile: string,
): { level: pino.Level; targets: pino.TransportTargetOptions[] } {
  const fileLevel = verbose ? VERBOSE_LEVEL : DEFAULT_FILE_LEVEL

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      level: fileLevel,
      options: { destination: logFile },
    },
  ]

  if (verbose) {
    targets.push({
      target: 'pino-pretty',
      level: VERBOSE_LEVEL,
      options: {
        destination: 2, // stderr
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    })
  }

  // Root level must match the most permissive target so nothing is filtered
  // before it reaches a target. When verbose, both targets are trace.
  return { level: fileLevel, targets }
}

/**
 * Create a Logger for CLI commands.
 *
 * Always writes JSON lines to `logs/<timestamp>.log` (info by default).
 * When verbose is true, raises the file log to trace and also writes
 * pretty-printed trace output to stderr.
 */
export function createLogger(verbose: boolean): Logger {
  const logFile = buildLogFilePath()
  const { level, targets } = buildLogTransport(verbose, logFile)
  const instance = pino({ level, transport: { targets } })
  return wrapPino(instance)
}
