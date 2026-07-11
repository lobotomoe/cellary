/** Navigation stack and view types for the monitor TUI */

/**
 * View identifiers for the right panel.
 * Each view maps to a component that renders in the right column.
 */
export type ViewId =
  | 'activity'
  | 'main-menu'
  | 'sms-menu'
  | 'sms-inbox'
  | 'sms-compose'
  | 'sms-read'
  | 'signal-detail'
  | 'ussd-prompt'
  | 'network-menu'
  | 'device-info'
  | 'data-status'
  | 'diagnostics'
  | 'at-console'
  | 'stk'

/** Data passed to views that need parameters (e.g. which SMS to display) */
export interface ViewParams {
  /** SMS index for sms-read view */
  readonly smsIndex?: number | undefined
}

export interface ViewStackEntry {
  readonly id: ViewId
  readonly params?: ViewParams | undefined
}

/** Menu item for list-based navigation */
export interface MenuItem {
  readonly id: string
  readonly label: string
  readonly hint?: string | undefined
  readonly badge?: string | undefined
}
