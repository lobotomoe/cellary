/**
 * Daemon configuration from environment variables.
 *
 * Validated with Zod at startup. Fails fast on invalid values.
 * Socket path is validated in getSocketPath() (shared with client).
 */

import { z } from 'zod'

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

const envSchema = z.object({
  CELLARY_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  /**
   * Numeric group id the IPC socket is chown'd to, so non-root clients in that
   * group can connect to the root daemon (Docker-style group gating). When
   * unset, the socket is owner-only (root) and clients must run as root.
   * The install command resolves the `cellary` group name to a gid and injects
   * this — the daemon takes a number to avoid platform-specific name lookup.
   */
  CELLARY_SOCKET_GID: z.coerce.number().int().nonnegative().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const fields = parsed.error.flatten().fieldErrors
  process.stderr.write(`Invalid environment variables:\n`)
  for (const [key, errors] of Object.entries(fields)) {
    if (errors !== undefined) {
      process.stderr.write(`  ${key}: ${errors.join(', ')}\n`)
    }
  }
  process.exit(1)
}

export const config = {
  logLevel: parsed.data.CELLARY_LOG_LEVEL ?? 'info',
  socketGid: parsed.data.CELLARY_SOCKET_GID,
} as const
