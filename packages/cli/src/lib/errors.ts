/**
 * CLI error handling.
 *
 * Wraps command execution with user-friendly error display.
 * CellaryError subclasses show .shortMessage; unknown errors show generic message.
 */

import { userInfo } from 'node:os'
import { CellaryError, NotSupportedError, TransportError } from 'cellary'

function buildPrivilegeHint(): string {
  const username = userInfo().username
  return (
    '\nThis modem is not visible as a serial port on macOS, so cellary\n' +
    'accessed it directly over USB — which requires administrator rights.\n' +
    '\nOptions:\n' +
    '  Once:        sudo cellary <command>\n' +
    '  Permanently: sudo visudo -f /etc/sudoers.d/cellary\n' +
    `               Add: ${username} ALL=(ALL) NOPASSWD: $(which cellary)\n`
  )
}

/**
 * Run an async command function with error handling.
 * Prints user-friendly message to stderr and exits with code 1 on failure.
 */
export async function withErrorHandling(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (error: unknown) {
    // Clear any in-progress \r line (e.g. retry progress) before printing the error
    process.stderr.write('\n')

    if (error instanceof CellaryError) {
      process.stderr.write(`Error: ${error.shortMessage}\n`)
      if (error.details) {
        process.stderr.write(`  ${error.details}\n`)
      }
      if (needsPrivilegeHint(error)) {
        process.stderr.write(buildPrivilegeHint())
      }
      if (error instanceof NotSupportedError) {
        process.stderr.write(
          '\nThis feature is not available with the current device/connection.\n' +
            'Run `cellary devices` to check device status.\n',
        )
      }
      if (isConnectionError(error)) {
        process.stderr.write(
          '\n  Possible causes:\n' +
            '  - Device still booting (wait 10-15s after plugging in)\n' +
            '  - USB connection unstable (try a different port or cable)\n' +
            '  - Device overheating (unplug, let it cool, replug)\n' +
            '\n  Run: cellary diagnose\n',
        )
      }
    } else if (error instanceof Error) {
      process.stderr.write(`Error: ${error.message}\n`)
    } else {
      process.stderr.write('An unexpected error occurred.\n')
    }
    process.exit(1)
  }
}

function needsPrivilegeHint(error: CellaryError): boolean {
  return (
    error.shortMessage.includes('elevated privileges') ||
    error.shortMessage.includes('Failed to open USB device') ||
    error.shortMessage.includes('Failed to claim USB interface')
  )
}

function isConnectionError(error: CellaryError): boolean {
  return error instanceof TransportError && error.shortMessage.includes('not responding')
}
