/**
 * Daemon configuration from environment variables.
 *
 * Validated with Zod at startup. Fails fast on invalid values.
 * Socket path is validated in getSocketPath() (shared with client).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

const envSchema = z.object({
  CELLARY_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  /** Directory for the durable device-comms audit log. Defaults under XDG state. */
  CELLARY_AUDIT_DIR: z.string().min(1).optional(),
  /** XDG state base dir, used to derive the default audit dir. */
  XDG_STATE_HOME: z.string().min(1).optional(),
  /** Rotate the audit file once it reaches this many bytes. Default 64 MiB. */
  CELLARY_AUDIT_MAX_BYTES: z.coerce.number().int().positive().optional(),
  /** Prune rotated audit files older than this many days. Default 365. */
  CELLARY_AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
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

const stateHome = parsed.data.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
const auditDir = parsed.data.CELLARY_AUDIT_DIR ?? join(stateHome, 'cellary', 'audit')

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_AUDIT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_AUDIT_RETENTION_DAYS = 365

export const config = {
  logLevel: parsed.data.CELLARY_LOG_LEVEL ?? 'info',
  socketGid: parsed.data.CELLARY_SOCKET_GID,
  /** File the device-comms audit is appended to. */
  auditFile: join(auditDir, 'comms.jsonl'),
  /** Size at which the audit file rotates. */
  auditMaxBytes: parsed.data.CELLARY_AUDIT_MAX_BYTES ?? DEFAULT_AUDIT_MAX_BYTES,
  /** How long rotated audit files are retained before pruning. */
  auditRetentionMs:
    (parsed.data.CELLARY_AUDIT_RETENTION_DAYS ?? DEFAULT_AUDIT_RETENTION_DAYS) * DAY_MS,
} as const
