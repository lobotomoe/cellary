/** SQLite-backed message store using better-sqlite3 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type { ArchivedMessage, MessageStore, StoredLogEntry } from './types.js'

const DB_DIR = join(homedir(), '.cellary')
const DB_FILE = 'store.db'
const SCHEMA_VERSION = 1

/** Bind params for message insert */
interface InsertMsgParams {
  sender: string
  text: string
  timestamp: string
  status: string
  storage: string
}

/** Bind params for paginated list */
interface PaginationParams {
  limit: number
  offset: number
}

/** Bind params for filtered list */
interface FilteredParams extends PaginationParams {
  from: string
}

interface CountRow {
  count: number
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function applyMigrations(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true })
  if (typeof version === 'number' && version >= SCHEMA_VERSION) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sender      TEXT NOT NULL,
      text        TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      status      TEXT NOT NULL,
      storage     TEXT NOT NULL DEFAULT 'SM',
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS activity_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT NOT NULL,
      session_date TEXT NOT NULL,
      type         TEXT NOT NULL,
      message      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_log_session ON activity_log(session_date);

    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
}

export function openStore(dbPath?: string): MessageStore {
  const resolvedPath = dbPath ?? join(DB_DIR, DB_FILE)
  ensureDir(dirname(resolvedPath))

  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  applyMigrations(db)

  // Typed prepared statements -- generic params eliminate `as` casts
  const insertMsg = db.prepare<InsertMsgParams>(`
    INSERT INTO messages (sender, text, timestamp, status, storage, archived_at)
    VALUES (@sender, @text, @timestamp, @status, @storage, datetime('now'))
  `)

  const selectMessages = db.prepare<PaginationParams, ArchivedMessage>(`
    SELECT id, sender AS "from", text, timestamp, status, storage, archived_at AS archivedAt
    FROM messages
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `)

  const selectByFrom = db.prepare<FilteredParams, ArchivedMessage>(`
    SELECT id, sender AS "from", text, timestamp, status, storage, archived_at AS archivedAt
    FROM messages
    WHERE sender = @from
    ORDER BY timestamp DESC
    LIMIT @limit OFFSET @offset
  `)

  const searchMessages = db.prepare<{ query: string }, ArchivedMessage>(`
    SELECT id, sender AS "from", text, timestamp, status, storage, archived_at AS archivedAt
    FROM messages
    WHERE text LIKE @query OR sender LIKE @query
    ORDER BY timestamp DESC
    LIMIT 100
  `)

  const selectOne = db.prepare<{ id: number }, ArchivedMessage>(`
    SELECT id, sender AS "from", text, timestamp, status, storage, archived_at AS archivedAt
    FROM messages
    WHERE id = @id
  `)

  const deleteMsg = db.prepare<{ id: number }>('DELETE FROM messages WHERE id = @id')

  const countMessages = db.prepare<[], CountRow>('SELECT COUNT(*) AS count FROM messages')

  const insertLog = db.prepare<{
    timestamp: string
    sessionDate: string
    type: string
    message: string
  }>(`
    INSERT INTO activity_log (timestamp, session_date, type, message)
    VALUES (@timestamp, @sessionDate, @type, @message)
  `)

  const selectLogs = db.prepare<{ limit: number }, StoredLogEntry>(`
    SELECT id, timestamp, session_date AS sessionDate, type, message
    FROM activity_log
    ORDER BY id DESC
    LIMIT @limit
  `)

  const sessionDate = new Date().toISOString().substring(0, 10)

  return {
    archiveMessage(msg) {
      const result = insertMsg.run({
        sender: msg.from,
        text: msg.text,
        timestamp: msg.timestamp.toISOString(),
        status: msg.status,
        storage: msg.storage,
      })
      return Number(result.lastInsertRowid)
    },

    listArchived(opts) {
      const limit = opts?.limit ?? 50
      const offset = opts?.offset ?? 0

      if (opts?.from !== undefined) {
        return selectByFrom.all({ from: opts.from, limit, offset })
      }
      return selectMessages.all({ limit, offset })
    },

    searchArchived(query) {
      return searchMessages.all({ query: `%${query}%` })
    },

    getArchived(id) {
      return selectOne.get({ id })
    },

    deleteArchived(id) {
      deleteMsg.run({ id })
    },

    archivedCount() {
      const row = countMessages.get()
      if (row === undefined) return 0
      return row.count
    },

    appendLog(entry) {
      insertLog.run({
        timestamp: entry.timestamp,
        sessionDate: sessionDate,
        type: entry.type,
        message: entry.message,
      })
    },

    recentLogs(limit) {
      const rows = selectLogs.all({ limit })
      return rows.reverse() // chronological order
    },

    close() {
      db.close()
    },
  }
}
