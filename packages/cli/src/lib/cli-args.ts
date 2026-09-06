/**
 * Shared citty argument definitions for modem-facing commands.
 */

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
