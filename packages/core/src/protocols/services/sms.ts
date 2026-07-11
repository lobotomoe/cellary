// ─── SMS Domain Types ────────────────────────────────────────────────────────

export interface SmsNotification {
  /** Storage location where the new message was saved */
  readonly storage: 'sim' | 'device' | 'unknown'
  readonly index: number
}

export interface SmsMessage {
  readonly index: number
  readonly from: string
  readonly text: string
  readonly timestamp: Date
  readonly status: 'unread' | 'read' | 'sent' | 'unsent'
}

/** SMS storage summary. */
export interface SmsCount {
  /** Number of messages in inbox storage. */
  readonly inbox: number
  /** Total capacity of inbox storage. */
  readonly capacity: number
  /** Number of unread messages. Not all protocols provide this efficiently. */
  readonly unread?: number | undefined
}

// ─── SMS Service Interface ───────────────────────────────────────────────────

export interface Sms {
  send(to: string, text: string): Promise<number>
  list(status?: 'all' | 'unread' | 'read' | 'sent' | 'unsent'): Promise<SmsMessage[]>
  read(index: number): Promise<SmsMessage>
  delete(index: number): Promise<void>
  /** Query SMS storage counts. Not all protocols provide this. */
  count?(): Promise<SmsCount>
}
