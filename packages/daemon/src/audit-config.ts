/**
 * Where the device-comms audit lives on disk.
 *
 * Shared by the daemon (running as root, writing its own state dir) and the
 * CLI's direct backend (the invoking user, writing theirs), so both record to
 * the same layout: <state>/cellary/audit/comms.jsonl, rotated in place.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export const AUDIT_FILE_NAME = 'comms.jsonl'

export interface AuditPathEnv {
  /** Explicit audit directory. Wins over the XDG default. */
  readonly CELLARY_AUDIT_DIR?: string | undefined
  /** XDG state base directory. Defaults to ~/.local/state. */
  readonly XDG_STATE_HOME?: string | undefined
}

/** Resolve the active audit file path from the environment. */
export function resolveAuditFile(env: AuditPathEnv, home: string = homedir()): string {
  const stateHome = env.XDG_STATE_HOME ?? join(home, '.local', 'state')
  const dir = env.CELLARY_AUDIT_DIR ?? join(stateHome, 'cellary', 'audit')
  return join(dir, AUDIT_FILE_NAME)
}
