/** Shared types and utilities for the monitor TUI */

export type LayoutMode = 'narrow' | 'normal' | 'wide'

export interface LogEntry {
  readonly timestamp: string
  readonly type: 'call' | 'sms' | 'network' | 'sim' | 'ussd' | 'command' | 'error'
  readonly message: string
  readonly color?: string | undefined
}

export function createTimestamp(): string {
  return new Date().toISOString().substring(11, 23)
}

export const MAX_LOG_ENTRIES = 50
