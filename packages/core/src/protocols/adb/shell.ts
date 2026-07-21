/**
 * ADB shell client.
 *
 * High-level wrapper over AdbConnectionLike for running shell commands
 * with timeout, error handling, and structured results.
 */

import { type AuditSink, noopAuditSink } from '../../audit.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import { ADB_SHELL_TIMEOUT_MS } from './constants.js'
import type { ShellResult } from './types.js'
import type { AdbConnectionLike } from './wire.js'

/** Redacts secrets from a command before it is logged/audited. Identity by default. */
export type CommandMask = (command: string) => string

const identityMask: CommandMask = (command) => command

export class AdbShell {
  private readonly _conn: AdbConnectionLike
  private readonly _log: Logger
  private readonly _audit: AuditSink
  private readonly _mask: CommandMask

  /**
   * @param maskCommand redacts secrets from a command before it reaches the log
   *   or audit. ADB is protocol-agnostic, so it does not know what may flow
   *   through it: a caller that pushes secret-bearing commands (e.g. the vendor
   *   AT bridge sending `AT+CPIN=<pin>` as a shell string) injects the masking.
   *   Generic shell traffic carries no secrets and is recorded as-is.
   */
  constructor(
    conn: AdbConnectionLike,
    logger?: Logger,
    auditSink?: AuditSink,
    maskCommand?: CommandMask,
  ) {
    this._conn = conn
    this._log = logger ?? noopLogger
    this._audit = auditSink ?? noopAuditSink
    this._mask = maskCommand ?? identityMask
  }

  /** The underlying ADB connection (for opening persistent streams). */
  get connection(): AdbConnectionLike {
    return this._conn
  }

  /**
   * Execute a shell command and return its output.
   *
   * The command runs in a fresh ADB shell stream. Each call opens and
   * closes its own stream — concurrent calls are safe.
   */
  async exec(command: string, timeoutMs?: number): Promise<ShellResult> {
    const timeout = timeoutMs ?? ADB_SHELL_TIMEOUT_MS
    // Mask before logging or auditing; the device still receives the raw command.
    const masked = this._mask(command)
    this._log.debug('Shell exec', { command: masked, timeout })
    this._audit.record({ timestamp: Date.now(), protocol: 'adb', direction: 'tx', text: masked })

    const raw = await this._conn.openShell(command, timeout)
    this._audit.record({
      timestamp: Date.now(),
      protocol: 'adb',
      direction: 'rx',
      text: this._mask(raw),
    })

    // Try to extract exit code from the output.
    // shell_v2 protocol appends exit code, but on older adbd (shell v1)
    // there's no exit code in the stream. We use a workaround:
    // append "; echo $?" to the command and parse the last line.
    // However, for simplicity we return the raw output and undefined exitCode
    // when not using the exit-code wrapper.
    return { stdout: raw, exitCode: undefined }
  }

  /**
   * Execute a command and parse exit code.
   *
   * Wraps the command to capture $? from the shell.
   * Use this when you need to know if the command succeeded.
   */
  async execWithStatus(command: string, timeoutMs?: number): Promise<ShellResult> {
    const timeout = timeoutMs ?? ADB_SHELL_TIMEOUT_MS
    // Wrap command to echo a delimiter + exit code at the end
    const delimiter = '___ADB_EXIT___'
    const wrapped = `${command}; echo ${delimiter}$?`

    const masked = this._mask(command)
    this._log.debug('Shell execWithStatus', { command: masked, timeout })
    this._audit.record({ timestamp: Date.now(), protocol: 'adb', direction: 'tx', text: masked })

    const raw = await this._conn.openShell(wrapped, timeout)

    const delimiterIdx = raw.lastIndexOf(delimiter)
    let result: ShellResult
    if (delimiterIdx === -1) {
      // Delimiter not found — command output may have been truncated
      result = { stdout: raw, exitCode: undefined }
    } else {
      const stdout = raw.substring(0, delimiterIdx)
      const exitCodeStr = raw.substring(delimiterIdx + delimiter.length).trim()
      const exitCode = Number(exitCodeStr)
      result = {
        stdout: stdout.trimEnd(),
        exitCode: Number.isNaN(exitCode) ? undefined : exitCode,
      }
    }

    this._audit.record({
      timestamp: Date.now(),
      protocol: 'adb',
      direction: 'rx',
      text: this._mask(result.stdout),
    })
    return result
  }

  /** Check if the ADB connection is alive. */
  async ping(): Promise<boolean> {
    try {
      const result = await this.exec('echo ok', 5_000)
      return result.stdout.trim() === 'ok'
    } catch {
      return false
    }
  }

  /** Whether the underlying connection is still open. */
  get isOpen(): boolean {
    return this._conn.isOpen
  }

  /** Close the underlying ADB connection. */
  async close(): Promise<void> {
    await this._conn.close()
  }
}
