/**
 * Durable device-comms audit for the CLI's direct (in-process) backend.
 *
 * Without the daemon the CLI talks to hardware itself, so it must record the
 * comms the same way the daemon does: masked records, append-only JSONL under
 * the invoking user's state dir, same rotation and retention. Core only emits
 * records; this is the host-side sink for the direct path.
 */

import { FileAuditSink, resolveAuditFile } from '@cellary/daemon/audit'
import type { AuditRecord, AuditSink, Logger } from 'cellary'
import { z } from 'zod'

const auditEnvSchema = z.object({
  CELLARY_AUDIT_DIR: z.string().min(1).optional(),
  XDG_STATE_HOME: z.string().min(1).optional(),
})

export interface DeviceAudit {
  /** Sink bound to one device, to hand to Modem.open() / Modem.detect(). */
  readonly sink: AuditSink
  /** Flush and close the underlying file. Idempotent. */
  close(): void
}

/**
 * Open the durable audit file and bind a sink to one device.
 *
 * Opening fails loud (unwritable state dir) because a silent no-op sink would
 * leave field failures undiagnosable. Once open, an append failure must never
 * break device comms, so it is logged and swallowed -- the daemon's policy.
 */
export function openDeviceAudit(
  deviceId: string,
  log: Logger,
  env: NodeJS.ProcessEnv = process.env,
): DeviceAudit {
  const parsed = auditEnvSchema.parse(env)
  const file = new FileAuditSink(resolveAuditFile(parsed), {
    onWarn: (message, err) => log.warn(message, { error: err }),
  })

  return {
    sink: {
      record(record: AuditRecord) {
        try {
          file.append(deviceId, record)
        } catch (err) {
          log.error('Audit append failed', { deviceId, error: err })
        }
      },
    },
    close() {
      file.close()
    },
  }
}
