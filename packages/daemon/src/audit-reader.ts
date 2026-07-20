/**
 * Reader for the device-comms audit log.
 *
 * The counterpart to FileAuditSink: it knows the same active + rotated file
 * naming convention and reads the tail of the log for the daemon.auditTail RPC,
 * so operators can inspect recent device traffic without shell access to the
 * daemon's state directory.
 *
 * Reads are bounded: at most the last window of bytes per file is read, so a
 * tail is cheap regardless of how large the log has grown. To satisfy a limit
 * that spans a rotation, it walks rotated files newest-first until it has enough.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { type AuditLine, auditLineSchema } from './ipc/protocol.js'

const DEFAULT_TAIL_LIMIT = 100
const DEFAULT_MAX_LIMIT = 10_000
/** Read at most this many trailing bytes per file. Holds thousands of records. */
const DEFAULT_TAIL_WINDOW_BYTES = 1024 * 1024

export interface AuditReaderOptions {
  readonly maxLimit?: number
  readonly tailWindowBytes?: number
}

export interface AuditTailQuery {
  readonly limit?: number | undefined
  readonly deviceId?: string | undefined
}

export class AuditReader {
  private readonly _path: string
  private readonly _maxLimit: number
  private readonly _windowBytes: number

  constructor(filePath: string, options: AuditReaderOptions = {}) {
    this._path = filePath
    this._maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT
    this._windowBytes = options.tailWindowBytes ?? DEFAULT_TAIL_WINDOW_BYTES
  }

  /**
   * Return the most recent records, oldest-first, optionally for one device.
   * Never throws on a missing log or a torn line -- a tail is best-effort by
   * nature; malformed lines are skipped.
   */
  tail(query: AuditTailQuery = {}): AuditLine[] {
    const requested = query.limit ?? DEFAULT_TAIL_LIMIT
    const limit = Math.min(Math.max(1, Math.trunc(requested)), this._maxLimit)

    // Accumulate in chronological order by prepending each older source's
    // block ahead of the newer records already collected.
    let collected: AuditLine[] = []
    for (const source of this._sourcesNewestFirst()) {
      const block = this._readRecords(source, query.deviceId)
      collected = [...block, ...collected]
      if (collected.length >= limit) break
    }

    return collected.slice(-limit)
  }

  /** Active file first (newest), then rotated files newest-first by mtime. */
  private _sourcesNewestFirst(): string[] {
    const dir = dirname(this._path)
    const prefix = `${basename(this._path)}.`

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      // No audit directory yet: nothing to read.
      return [this._path]
    }

    const rotated = entries
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dir, name))
      .map((full) => ({ full, mtimeMs: safeMtimeMs(full) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => entry.full)

    return [this._path, ...rotated]
  }

  /** Parse valid, device-matching records from a file's tail window. */
  private _readRecords(path: string, deviceId: string | undefined): AuditLine[] {
    const records: AuditLine[] = []
    for (const line of this._readTailLines(path)) {
      let json: unknown
      try {
        json = JSON.parse(line)
      } catch {
        continue // torn or partial line
      }
      const parsed = auditLineSchema.safeParse(json)
      if (!parsed.success) continue
      if (deviceId !== undefined && parsed.data.deviceId !== deviceId) continue
      records.push(parsed.data)
    }
    return records
  }

  /** Read the last window of a file and return its complete lines, in order. */
  private _readTailLines(path: string): string[] {
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return [] // file not created yet, or a rotated file vanished mid-read
    }

    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - this._windowBytes)
      const length = size - start
      if (length === 0) return []

      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf8')

      // If we started mid-file, the first line is a partial fragment: drop it.
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }

      return text.split('\n').filter((line) => line.length > 0)
    } finally {
      closeSync(fd)
    }
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
