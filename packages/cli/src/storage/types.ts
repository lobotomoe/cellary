/** Storage layer types */

/** Archived SMS message (SIM -> local DB) */
export interface ArchivedMessage {
  readonly id: number
  readonly from: string
  readonly text: string
  readonly timestamp: string // ISO 8601
  readonly status: 'unread' | 'read' | 'sent' | 'unsent'
  readonly storage: string // 'SM', 'ME', etc.
  readonly archivedAt: string // ISO 8601
}

/** Persisted activity log entry */
export interface StoredLogEntry {
  readonly id: number
  readonly timestamp: string // HH:MM:SS.mmm
  readonly sessionDate: string // ISO 8601 date (groups entries by session)
  readonly type: string
  readonly message: string
}

/** Storage interface -- all methods are synchronous (better-sqlite3) */
export interface MessageStore {
  // SMS archive
  archiveMessage(msg: {
    from: string
    text: string
    /** Absent for stored outgoing messages (SMS-SUBMIT carries no timestamp). */
    timestamp: Date | undefined
    status: string
    storage: string
  }): number

  listArchived(opts?: {
    from?: string
    limit?: number
    offset?: number
  }): readonly ArchivedMessage[]

  searchArchived(query: string): readonly ArchivedMessage[]

  getArchived(id: number): ArchivedMessage | undefined

  deleteArchived(id: number): void

  archivedCount(): number

  // Activity log
  appendLog(entry: { timestamp: string; type: string; message: string }): void

  recentLogs(limit: number): readonly StoredLogEntry[]

  // Lifecycle
  close(): void
}
