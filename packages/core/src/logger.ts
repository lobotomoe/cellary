/**
 * Structured logger interface.
 *
 * Core defines this interface but never implements it — zero logging dependencies.
 * Consumer code (CLI, tests, apps) provides the implementation.
 * When no logger is provided, noopLogger is used — zero overhead.
 *
 * @example
 * ```ts
 * import { Modem, type Logger } from 'cellary'
 *
 * const logger: Logger = {
 *   trace(msg, data) { console.debug(msg, data) },
 *   debug(msg, data) { console.debug(msg, data) },
 *   info(msg, data) { console.info(msg, data) },
 *   warn(msg, data) { console.warn(msg, data) },
 *   error(msg, data) { console.error(msg, data) },
 *   child() { return this },
 * }
 *
 * const modem = await Modem.detect(undefined, { logger })
 * ```
 */
export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  /** Create a child logger that inherits this logger's context plus the given bindings. */
  child(bindings: Record<string, unknown>): Logger
}

/** No-op logger. All methods are empty. Zero overhead when logging is disabled. */
export const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
}
