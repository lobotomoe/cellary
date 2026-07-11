import type { EventEmitter } from 'node:events'
import type { StkMenu } from '../../stk-types.js'

/**
 * SIM Toolkit service interface.
 *
 * Extends EventEmitter because STK is event-driven: the SIM pushes proactive
 * commands (menu, display text, get input) rather than the host polling.
 */
export interface Stk extends EventEmitter {
  readonly enabled: boolean
  readonly menu: StkMenu | undefined
  enable(): Promise<void>
  disable(): void
  select(itemId: number): Promise<void>
  confirm(): Promise<void>
  input(text: string): Promise<void>
  key(char: string): Promise<void>
  back(): Promise<void>
  endSession(): Promise<void>
}
