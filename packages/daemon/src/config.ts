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
} as const
