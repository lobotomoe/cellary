// ── STK Domain Types ──────────────────────────────────────────────────────
//
// Protocol-agnostic data structures for SIM Toolkit (STK) proactive commands.
// These describe what the SIM application presents to the user, regardless
// of whether the data arrived via AT commands, HiLink HTTP, or another protocol.

export interface StkMenuItem {
  readonly id: number
  readonly label: string
}

export interface StkMenu {
  readonly type: 'menu'
  readonly title: string
  readonly items: readonly StkMenuItem[]
}

export interface StkText {
  readonly type: 'text'
  readonly text: string
  /** 0 = wait for user dismiss, 1 = clear after delay */
  readonly clearMode: number
  /** 0 = normal, 1 = high */
  readonly priority: number
}

export interface StkInputPrompt {
  readonly type: 'input'
  readonly prompt: string
  readonly minLength: number
  readonly maxLength: number
  /** 0 = digits only, 1 = alphanumeric */
  readonly mode: number
  /** 0 = SMS default, 1 = UCS2 */
  readonly format: number
}

export interface StkInkeyPrompt {
  readonly type: 'inkey'
  readonly prompt: string
  /** 0 = digits only, 1 = alphanumeric, 2 = yes/no */
  readonly mode: number
  /** 0 = SMS default, 1 = UCS2 */
  readonly format: number
}

/**
 * Notification for transparent proactive commands (Send SMS, Send USSD, etc.).
 *
 * The modem handles these internally. The host receives ^STIN but STGI
 * typically fails (CME ERROR 50) on modems where the firmware owns these commands. We emit the raw
 * indication so callers can observe what the SIM is doing.
 */
export interface StkNotification {
  readonly type: 'notification'
  readonly commandType: number
  readonly subType: number
  readonly qualifier: number
}

/** Discriminated union of all proactive command events */
export type StkProactiveEvent =
  | StkMenu
  | StkText
  | StkInputPrompt
  | StkInkeyPrompt
  | StkNotification

/** Events emitted by STK implementations */
export interface StkEventMap {
  menu: [event: StkMenu]
  text: [event: StkText]
  input: [event: StkInputPrompt]
  inkey: [event: StkInkeyPrompt]
  notification: [event: StkNotification]
  'session:end': []
  error: [error: Error]
}
