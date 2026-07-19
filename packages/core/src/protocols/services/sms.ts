// ─── SMS Domain Types ────────────────────────────────────────────────────────

export interface SmsNotification {
  /** Storage location where the new message was saved */
  readonly storage: 'sim' | 'device' | 'unknown'
  readonly index: number
}

export interface SmsMessage {
  readonly index: number
  /**
   * Peer address: the sender for incoming messages, the recipient for stored
   * outgoing (sent/unsent) messages. Interpret via `direction`.
   */
  readonly address: string
  /** Message direction. Incoming = SMS-DELIVER, outgoing = stored SMS-SUBMIT. */
  readonly direction: 'incoming' | 'outgoing'
  readonly text: string
  /**
   * Service-centre timestamp for incoming messages. Absent for stored outgoing
   * messages — SMS-SUBMIT PDUs carry no timestamp, and fabricating one would be
   * a lie.
   */
  readonly timestamp?: Date | undefined
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
