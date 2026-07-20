/**
 * Device & external-communication audit.
 *
 * The library emits an {@link AuditRecord} for every message exchanged with a
 * device, masked at the boundary (see maskAtSecrets) so secrets never reach it.
 * Core does NOT own persistence: a durable, append-only sink is the host's
 * responsibility (e.g. the daemon writes JSONL to its own file, separate from
 * the rotating app log). Core ships only a no-op sink, so auditing is opt-in.
 */

export interface AuditRecord {
  /** Epoch milliseconds when the message was observed. */
  readonly timestamp: number
  /** Protocol the message belongs to, e.g. 'at'. */
  readonly protocol: string
  /** 'tx' = sent to the device, 'rx' = received from it. */
  readonly direction: 'tx' | 'rx'
  /** The message text, already masked of any secrets. Empty for a bare outcome. */
  readonly text: string
  /** Terminal outcome for an exchange when the text alone doesn't convey it (e.g. 'timeout'). */
  readonly outcome?: string | undefined
}

export interface AuditSink {
  record(entry: AuditRecord): void
}

/** Default sink: discards records. Auditing is opt-in via a real sink. */
export const noopAuditSink: AuditSink = {
  record() {},
}
