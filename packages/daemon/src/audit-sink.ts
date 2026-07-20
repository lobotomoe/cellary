/**
 * Durable, append-only device-comms audit sink.
 *
 * Persists the masked AuditRecords the core library emits (see cellary's
 * AuditSink) to a JSONL file, one line per message, separate from the rotating
 * pino app log. This is the primary feedback loop for diagnosing field failures:
 * when a modem misbehaves on a machine we can't reach, this file is what we have.
 *
 * The file is opened O_APPEND (mode 0600) so records are only ever appended and
 * survive daemon restarts. Records arrive already masked -- no secrets reach here.
 */

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditRecord } from 'cellary'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export class FileAuditSink {
  private readonly _fd: number

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE })
    // 'a' = append-only. Mode applies only when the file is created.
    this._fd = openSync(filePath, 'a', FILE_MODE)
  }

  /** Append one masked record for a device as a JSONL line. */
  append(deviceId: string, record: AuditRecord): void {
    const entry = {
      ts: record.timestamp,
      deviceId,
      protocol: record.protocol,
      dir: record.direction,
      text: record.text,
      ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    }
    // O_APPEND makes each write atomically land at end of file.
    writeSync(this._fd, `${JSON.stringify(entry)}\n`)
  }

  close(): void {
    closeSync(this._fd)
  }
}
