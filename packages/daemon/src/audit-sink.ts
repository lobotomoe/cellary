/**
 * Durable, append-only device-comms audit sink.
 *
 * Persists the masked AuditRecords the core library emits (see cellary's
 * AuditSink) to a JSONL file, one line per message, separate from the rotating
 * pino app log. This is the primary feedback loop for diagnosing field failures:
 * when a modem misbehaves on a machine we can't reach, this file is what we have.
 *
 * Durability model:
 * - The active file is opened O_APPEND (mode 0600) so records only ever append
 *   and survive daemon restarts. Records arrive already masked -- no secrets here.
 * - Data is flushed to disk with fdatasync on a bounded interval (group commit),
 *   before every rotation, and on close -- so power loss costs at most one
 *   interval of records, without paying an fsync per write.
 * - The file is size-rotated so no single file grows unbounded, and rotated
 *   files older than the retention window are pruned so history stays generous
 *   (>= 1 year by default) without growing forever.
 */

import {
  closeSync,
  fdatasyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AuditRecord } from 'cellary'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000
const DEFAULT_FSYNC_INTERVAL_MS = 5_000

export interface FileAuditSinkOptions {
  /** Rotate the active file once it reaches this many bytes. */
  readonly maxBytes?: number
  /** Prune rotated files older than this. Defaults to one year. */
  readonly retentionMs?: number
  /** Interval between background fdatasync flushes. */
  readonly fsyncIntervalMs?: number
  /** Injectable clock (ms). Defaults to Date.now. */
  readonly now?: () => number
  /** Best-effort housekeeping warnings (prune failures). */
  readonly onWarn?: (message: string, err: unknown) => void
}

export class FileAuditSink {
  private readonly _path: string
  private readonly _maxBytes: number
  private readonly _retentionMs: number
  private readonly _now: () => number
  private readonly _onWarn: ((message: string, err: unknown) => void) | undefined
  private readonly _flushTimer: ReturnType<typeof setInterval>

  private _fd: number
  private _bytesWritten: number
  private _dirty = false
  private _rotationSeq = 0
  private _closed = false

  constructor(filePath: string, options: FileAuditSinkOptions = {}) {
    this._path = filePath
    this._maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this._retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this._now = options.now ?? Date.now
    this._onWarn = options.onWarn

    mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE })
    // 'a' = append-only. Mode applies only when the file is created.
    this._fd = openSync(filePath, 'a', FILE_MODE)
    // Seed from the existing size so rotation tracks total file size across
    // restarts, not just bytes written this session.
    this._bytesWritten = fstatSync(this._fd).size

    const intervalMs = options.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS
    this._flushTimer = setInterval(() => {
      this._flush()
    }, intervalMs)
    // Never keep the daemon alive just for the flush timer.
    this._flushTimer.unref()

    // A restart is a good moment to drop history that has aged out.
    this._prune()
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
    const written = writeSync(this._fd, `${JSON.stringify(entry)}\n`)
    this._bytesWritten += written
    this._dirty = true

    if (this._bytesWritten >= this._maxBytes) {
      this._rotate()
    }
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    clearInterval(this._flushTimer)
    this._flush()
    closeSync(this._fd)
  }

  /** fdatasync only when there is unsynced data, so idle ticks are free. */
  private _flush(): void {
    if (!this._dirty) return
    fdatasyncSync(this._fd)
    this._dirty = false
  }

  private _rotate(): void {
    // Flush and close the active fd before renaming so the rotated file is
    // durable and no further writes land in it.
    this._flush()
    closeSync(this._fd)

    const stamp = new Date(this._now()).toISOString().replace(/[:.]/g, '-')
    const rotated = `${this._path}.${stamp}-${this._rotationSeq}`
    this._rotationSeq += 1
    renameSync(this._path, rotated)

    this._fd = openSync(this._path, 'a', FILE_MODE)
    this._bytesWritten = 0
    this._dirty = false

    this._prune()
  }

  /**
   * Best-effort retention: drop rotated files whose last write predates the
   * retention window. A rotated file's mtime is the time of its newest record,
   * so mtime-based pruning never deletes data younger than the window.
   * Housekeeping must never break the write path, so failures are reported via
   * onWarn rather than thrown.
   */
  private _prune(): void {
    const dir = dirname(this._path)
    const prefix = `${basename(this._path)}.`
    const cutoff = this._now() - this._retentionMs

    let names: string[]
    try {
      names = readdirSync(dir)
    } catch (err) {
      this._onWarn?.('audit prune: directory scan failed', err)
      return
    }

    for (const name of names) {
      if (!name.startsWith(prefix)) continue
      const full = join(dir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full)
        }
      } catch (err) {
        this._onWarn?.(`audit prune: could not prune ${name}`, err)
      }
    }
  }
}
