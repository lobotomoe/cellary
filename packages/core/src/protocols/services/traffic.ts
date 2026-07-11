// ─── Traffic Domain Types ────────────────────────────────────────────────────

/** Data transfer statistics for a session or billing period. */
export interface TrafficStats {
  readonly downloadBytes: number
  readonly uploadBytes: number
  readonly durationSeconds: number
  /** Current download rate in bytes/sec. Available for session stats only. */
  readonly downloadRate?: number | undefined
  /** Current upload rate in bytes/sec. Available for session stats only. */
  readonly uploadRate?: number | undefined
}

// ─── Traffic Service Interface ───────────────────────────────────────────────

export interface Traffic {
  /** Current session statistics (download/upload/duration/rates). */
  session(): Promise<TrafficStats>
  /** Monthly billing period statistics. Not all protocols provide this. */
  monthly?(): Promise<TrafficStats>
}
