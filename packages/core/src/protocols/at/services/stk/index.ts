import { EventEmitter } from 'node:events'
import { StkError } from '../../../../errors.js'
import type { Stk } from '../../../adapter.js'
import type { ATChannel } from '../../channel/at-channel.js'
import type { AtConfig, StkConfig } from '../../types.js'
import type { StkMenu, StkNotification } from './types.js'

const STK_TIMEOUT_MS = 10_000

/**
 * SIM Toolkit (STK) module.
 *
 * Unlike other modules, STK is event-driven: the SIM pushes proactive
 * commands to the host. This module registers its own URC handler and
 * emits typed events for each command type.
 *
 * Requires vendor-specific STK configuration (AtConfig.stk) that provides
 * command type numbering, response codes, and a response parser.
 *
 * Opt-in via `modem.stk.enable()`. Caller listens for events:
 *
 * ```ts
 * modem.stk.on('menu', (menu) => {
 *   console.log(menu.title, menu.items)
 *   modem.stk.select(menu.items[0].id)
 * })
 *
 * modem.stk.on('text', (text) => {
 *   console.log(text.text)
 *   modem.stk.confirm()
 * })
 *
 * await modem.stk.enable()
 * ```
 *
 * Events: 'menu', 'text', 'input', 'inkey', 'session:end', 'error'
 */
export class StkModule extends EventEmitter implements Stk {
  private readonly channel: ATChannel
  private readonly profile: AtConfig
  private readonly _stkConfig: StkConfig | undefined

  private _enabled = false
  private _unsubscribe: (() => void) | undefined
  private _pendingCommandType: number | undefined
  private _rootMenu: StkMenu | undefined

  constructor(channel: ATChannel, profile: AtConfig) {
    super()
    this.channel = channel
    this.profile = profile
    this._stkConfig = profile.stk
  }

  /** Whether STK is currently enabled and listening for proactive commands */
  get enabled(): boolean {
    return this._enabled
  }

  /** The cached root SIM menu, available after the SIM sends a Setup Menu command */
  get menu(): StkMenu | undefined {
    return this._rootMenu
  }

  /**
   * Get the STK config, throwing if not configured.
   * Every method that needs vendor-specific STK behaviour goes through this.
   */
  private get stkConfig(): StkConfig {
    if (this._stkConfig === undefined) {
      throw new StkError(
        'STK not configured: profile must provide stk config (commandTypes, responseCodes, parseResponse)',
      )
    }
    return this._stkConfig
  }

  /**
   * Enable STK and start listening for proactive commands.
   *
   * Sends the STK enable command and registers the URC handler.
   */
  async enable(): Promise<void> {
    if (this._enabled) return

    // Validate STK config is present (throws StkError if not)
    const cfg = this.stkConfig

    const enableCmd = this.profile.commands?.stkEnable
    if (enableCmd === undefined) {
      throw new StkError(
        'STK not configured: profile must provide commands.stkEnable, stkIndication, stkGetInfo, stkRespond',
      )
    }

    try {
      await this.channel.execute(enableCmd, { timeout: STK_TIMEOUT_MS })
    } catch (err: unknown) {
      throw new StkError(`STK enable failed: ${enableCmd}`, { cause: err })
    }

    const indicationPrefix = this.profile.commands?.stkIndication
    if (indicationPrefix === undefined) {
      throw new StkError('STK not configured: profile must provide commands.stkIndication')
    }
    this._unsubscribe = this.channel.onURC(indicationPrefix, (urc) => {
      this.handleIndication(urc.body)
    })

    this._enabled = true

    // Proactively fetch the root menu. Many modems (E3372, E8372) don't
    // push ^STIN automatically after enable -- the host must request it.
    await this.fetchRootMenu(cfg)
  }

  /**
   * Try to fetch the root SIM menu via STGI.
   * Non-fatal: if the SIM has no menu or STGI fails, we just wait for URCs.
   */
  private async fetchRootMenu(cfg: StkConfig): Promise<void> {
    try {
      this._pendingCommandType = cfg.commandTypes.setupMenu
      await this.processProactiveCommand(cfg.commandTypes.setupMenu)
    } catch {
      // Not all SIMs have a root menu, or STGI may fail -- that's OK
      this._pendingCommandType = undefined
    }
  }

  /**
   * Disable STK and stop listening for proactive commands.
   *
   * Clears internal state. Does NOT send a disable command to the modem
   * (STK disable is rarely needed and may confuse some devices).
   */
  disable(): void {
    if (!this._enabled) return

    this._unsubscribe?.()
    this._unsubscribe = undefined
    this._pendingCommandType = undefined
    this._enabled = false
  }

  // -- Response Methods -----------------------------------------------------------

  /** Respond to a Menu or Select Item by choosing an item */
  async select(itemId: number): Promise<void> {
    const cfg = this.stkConfig
    this.assertPendingType(cfg.commandTypes.setupMenu, cfg.commandTypes.selectItem)
    const cmdType = this._pendingCommandType
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(`${respondCmd}=${cmdType},${cfg.responseCodes.ok},${itemId}`, {
      timeout: STK_TIMEOUT_MS,
    })
  }

  /** Acknowledge a Display Text command */
  async confirm(): Promise<void> {
    const cfg = this.stkConfig
    this.assertPendingType(cfg.commandTypes.displayText)
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(
      `${respondCmd}=${cfg.commandTypes.displayText},${cfg.responseCodes.ok}`,
      { timeout: STK_TIMEOUT_MS },
    )
  }

  /** Respond to a Get Input prompt */
  async input(text: string): Promise<void> {
    const cfg = this.stkConfig
    this.assertPendingType(cfg.commandTypes.getInput)
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(
      `${respondCmd}=${cfg.commandTypes.getInput},${cfg.responseCodes.ok},"${text}"`,
      { timeout: STK_TIMEOUT_MS },
    )
  }

  /** Respond to a Get Inkey prompt */
  async key(char: string): Promise<void> {
    const cfg = this.stkConfig
    this.assertPendingType(cfg.commandTypes.getInkey)
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(
      `${respondCmd}=${cfg.commandTypes.getInkey},${cfg.responseCodes.ok},"${char}"`,
      { timeout: STK_TIMEOUT_MS },
    )
  }

  /** Go back / cancel the current proactive command */
  async back(): Promise<void> {
    const cfg = this.stkConfig
    const cmdType = this._pendingCommandType
    if (cmdType === undefined) {
      throw new StkError('No pending STK command to cancel')
    }
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(`${respondCmd}=${cmdType},${cfg.responseCodes.backward}`, {
      timeout: STK_TIMEOUT_MS,
    })
  }

  /** End the current STK session */
  async endSession(): Promise<void> {
    const cfg = this.stkConfig
    const cmdType = this._pendingCommandType
    if (cmdType === undefined) {
      throw new StkError('No pending STK command to end session')
    }
    this._pendingCommandType = undefined

    const respondCmd = this.stkRespond()
    await this.channel.execute(`${respondCmd}=${cmdType},${cfg.responseCodes.endSession}`, {
      timeout: STK_TIMEOUT_MS,
    })
  }

  // -- Private --------------------------------------------------------------------

  /**
   * Handle URC indication body.
   *
   * Format: `<cmdType>[, <subType>[, <qualifier>]]`
   *
   * This is a sync handler (as required by onURC). It parses the indication
   * and either spawns async processing (interactive commands) or emits a
   * notification (transparent commands the modem handles internally).
   */
  private handleIndication(body: string): void {
    const cfg = this.stkConfig
    const parts = body.split(',').map((s) => s.trim())
    const commandType = Number.parseInt(parts[0] ?? '', 10)
    if (Number.isNaN(commandType)) {
      this.emit('error', new StkError(`Invalid STK indication: ${body}`))
      return
    }

    const rawSubType = Number.parseInt(parts[1] ?? '0', 10)
    const rawQualifier = Number.parseInt(parts[2] ?? '0', 10)
    const subType = Number.isNaN(rawSubType) ? 0 : rawSubType
    const qualifier = Number.isNaN(rawQualifier) ? 0 : rawQualifier

    // Session end is a special indication with no follow-up
    if (commandType === cfg.sessionEndType) {
      this._pendingCommandType = undefined
      this.emit('session:end')
      return
    }

    // Transparent commands: the modem handles these internally (Send SMS,
    // Send SS, Send USSD, Setup Call). STGI typically returns CME ERROR 50
    // on modems where the firmware handles these commands internally. Emit a notification instead.
    if (this.isTransparentCommand(cfg, commandType)) {
      const notification: StkNotification = {
        type: 'notification',
        commandType,
        subType,
        qualifier,
      }
      this.emit('notification', notification)
      return
    }

    this._pendingCommandType = commandType

    // URC-to-async bridge: sync handler spawns async processing
    this.processProactiveCommand(commandType).catch((err: unknown) => {
      const error = err instanceof Error ? err : new StkError(`STK processing failed: ${err}`)
      this.emit('error', error)
    })
  }

  /**
   * Fetch and parse the proactive command details, then emit the typed event.
   */
  private async processProactiveCommand(commandType: number): Promise<void> {
    const cfg = this.stkConfig
    const getInfoCmd = this.stkGetInfo()
    const cmd = `${getInfoCmd}=${commandType}`
    const result = await this.channel
      .execute(cmd, { timeout: STK_TIMEOUT_MS })
      .catch((err: unknown) => {
        throw new StkError(`STK get info failed: ${cmd}`, {
          cause: err instanceof Error ? err : undefined,
        })
      })

    const event = cfg.parseResponse(commandType, result.lines)

    // Cache root menu for direct access
    if (commandType === cfg.commandTypes.setupMenu && event.type === 'menu') {
      this._rootMenu = event
    }

    this.emit(event.type, event)
  }

  /** Get STK respond command from profile. Throws if not configured. */
  private stkRespond(): string {
    const cmd = this.profile.commands?.stkRespond
    if (cmd === undefined) {
      throw new StkError('STK not configured: profile must provide commands.stkRespond')
    }
    return cmd
  }

  /** Get STK get-info command from profile. Throws if not configured. */
  private stkGetInfo(): string {
    const cmd = this.profile.commands?.stkGetInfo
    if (cmd === undefined) {
      throw new StkError('STK not configured: profile must provide commands.stkGetInfo')
    }
    return cmd
  }

  /** Transparent commands the modem handles internally (no STGI data for the host) */
  private isTransparentCommand(cfg: StkConfig, commandType: number): boolean {
    const ct = cfg.commandTypes
    return (
      commandType === ct.sendSms ||
      commandType === ct.sendSs ||
      commandType === ct.sendUssd ||
      commandType === ct.setupCall
    )
  }

  private assertPendingType(...expectedTypes: number[]): void {
    if (this._pendingCommandType === undefined) {
      throw new StkError('No pending STK command')
    }

    if (!expectedTypes.some((t) => t === this._pendingCommandType)) {
      const expected = expectedTypes.join(' or ')
      throw new StkError(
        `Expected pending command type ${expected}, got ${this._pendingCommandType}`,
      )
    }
  }
}
