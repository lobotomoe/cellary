/**
 * CLI logger factory.
 *
 * Wraps pino into the core Logger interface so library code gets structured
 * logging without depending on pino directly.
 *
 * File logging (JSON lines in `logs/`) is always active — every CLI run
 * produces a log file for post-mortem analysis. Log files are gitignored.
 *
 * With --verbose, pretty-printed trace output also goes to stderr.
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
 * Create a Logger for CLI commands.
 *
 * Always writes JSON lines to `logs/<timestamp>.log`.
 * When verbose is true, also writes pretty-printed trace output to stderr.
 */
export function createLogger(verbose: boolean): Logger {
  const logFile = buildLogFilePath()

  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      level: 'trace',
      options: { destination: logFile },
    },
  ]

  if (verbose) {
    targets.push({
      target: 'pino-pretty',
      level: 'trace',
      options: {
        destination: 2, // stderr
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    })
  }

  const instance = pino({
    level: 'trace',
    transport: { targets },
  })

  return wrapPino(instance)
}
