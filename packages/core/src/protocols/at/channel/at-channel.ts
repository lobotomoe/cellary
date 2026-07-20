import {
  ATError,
  ChannelDisposedError,
  ChannelUnresponsiveError,
  QueueFullError,
  TimeoutError,
} from '../../../errors.js'
import type { Logger } from '../../../logger.js'
import { noopLogger } from '../../../logger.js'
import type { Transport } from '../../../types.js'
import type { ATCommand, ATCommandResult, ATResultCode, URC, URCHandler } from '../types.js'
import { LineAssembler } from './line-assembler.js'
import { maskAtSecrets } from './mask.js'
import { parseLine } from './parser.js'

type ChannelState = 'idle' | 'command_sent' | 'awaiting_prompt' | 'data_input'

interface QueueEntry {
  readonly command: ATCommand
  readonly resolve: (result: ATCommandResult) => void
  readonly reject: (error: Error) => void
}

export interface ATChannelOptions {
  /** Known URC prefixes to register */
  readonly urcPrefixes?: readonly string[] | undefined
  /** Default command timeout in milliseconds. @default 10000 */
  readonly defaultTimeout?: number | undefined
  /** Per-command timeout overrides (command prefix → ms) */
  readonly commandTimeouts?: Readonly<Record<string, number>> | undefined
  /** Structured logger. @default noopLogger */
  readonly logger?: Logger | undefined
  /** Maximum number of queued commands before rejecting new ones. @default 64 */
  readonly maxQueueSize?: number | undefined
  /**
   * Number of consecutive command timeouts before declaring the channel
   * unresponsive and invoking the onUnresponsive callback. @default 3
   */
  readonly consecutiveTimeoutThreshold?: number | undefined
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_QUEUE_SIZE = 64
const DEFAULT_CONSECUTIVE_TIMEOUT_THRESHOLD = 3
const EMPTY_URC_SET: ReadonlySet<string> = new Set()

/**
 * The AT command engine.
 *
 * Manages command serialization (one command at a time), response collection,
 * URC dispatch, prompt handling, and timeouts.
 *
 * @example
 * ```ts
 * const channel = new ATChannel(transport, {
 *   urcPrefixes: ['+CMTI', '+CREG', 'RING'],
 * })
 *
 * const result = await channel.execute('AT+CSQ')
 * // result.lines = ['+CSQ: 18,99']
 *
 * channel.onURC('+CMTI', (urc) => {
 *   console.log('New SMS at index', urc.body)
 * })
 * ```
 */
export class ATChannel {
  private state: ChannelState = 'idle'
  private disposed = false
  private unresponsive = false
  private consecutiveTimeouts = 0

  private readonly queue: QueueEntry[] = []
  private currentEntry: QueueEntry | null = null
  private currentResponseLines: string[] = []
  private commandTimer: ReturnType<typeof setTimeout> | null = null
  private commandStartTime = 0
  /**
   * True while discarding a timed-out command's late response until the next
   * command's echo re-aligns the stream. See handleTimeout()/handleLine().
   */
  private resyncing = false

  private readonly urcPrefixes: Set<string>
  private readonly urcHandlers = new Map<string, URCHandler[]>()
  private readonly catchAllHandlers: URCHandler[] = []

  private readonly defaultTimeout: number
  private readonly commandTimeouts: Readonly<Record<string, number>>
  private readonly _maxQueueSize: number
  private readonly _consecutiveTimeoutThreshold: number
  private readonly lineAssembler: LineAssembler
  private readonly _log: Logger
  private _onUnresponsive: (() => void) | undefined

  constructor(
    private readonly transport: Transport,
    options?: ATChannelOptions,
  ) {
    this._log = options?.logger ?? noopLogger
    this.urcPrefixes = new Set(options?.urcPrefixes ?? [])
    this.defaultTimeout = options?.defaultTimeout ?? DEFAULT_TIMEOUT
    this.commandTimeouts = options?.commandTimeouts ?? {}
    this._maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this._consecutiveTimeoutThreshold =
      options?.consecutiveTimeoutThreshold ?? DEFAULT_CONSECUTIVE_TIMEOUT_THRESHOLD

    this.lineAssembler = new LineAssembler({
      onLine: (line) => this.handleLine(line),
      onPrompt: () => this.handlePrompt(),
    })

    // Wire transport data to line assembler
    this.transport.onData((data) => {
      this.lineAssembler.feed(data)
    })
  }

  /**
   * Execute an AT command and wait for its response.
   * Commands are serialized — only one runs at a time.
   */
  execute(
    command: string,
    options?: Partial<Pick<ATCommand, 'timeout' | 'expectsPrompt' | 'promptData' | 'suppressURC'>>,
  ): Promise<ATCommandResult> {
    if (this.disposed) {
      return Promise.reject(new ChannelDisposedError())
    }
    if (this.unresponsive) {
      return Promise.reject(new ChannelUnresponsiveError())
    }
    if (this.queue.length >= this._maxQueueSize) {
      return Promise.reject(new QueueFullError(command, this.queue.length))
    }

    const timeout = options?.timeout ?? this.resolveTimeout(command)
    const atCommand: ATCommand = {
      raw: command,
      timeout,
      expectsPrompt: options?.expectsPrompt,
      promptData: options?.promptData,
      suppressURC: options?.suppressURC,
    }

    return new Promise<ATCommandResult>((resolve, reject) => {
      this.queue.push({ command: atCommand, resolve, reject })
      if (this.state === 'idle') {
        this.processQueue()
      }
    })
  }

  /** Register a handler for a specific URC prefix. Returns an unsubscribe function. */
  onURC(prefix: string, handler: URCHandler): () => void {
    // Ensure prefix is in the known set
    this.urcPrefixes.add(prefix)

    let handlers = this.urcHandlers.get(prefix)
    if (!handlers) {
      handlers = []
      this.urcHandlers.set(prefix, handlers)
    }
    handlers.push(handler)

    return () => {
      const list = this.urcHandlers.get(prefix)
      if (list) {
        const idx = list.indexOf(handler)
        if (idx !== -1) list.splice(idx, 1)
      }
    }
  }

  /** Register a catch-all handler for all URCs. Returns an unsubscribe function. */
  onAnyURC(handler: URCHandler): () => void {
    this.catchAllHandlers.push(handler)
    return () => {
      const idx = this.catchAllHandlers.indexOf(handler)
      if (idx !== -1) this.catchAllHandlers.splice(idx, 1)
    }
  }

  /** Add URC prefixes to the known set */
  registerURCPrefixes(prefixes: readonly string[]): void {
    for (const prefix of prefixes) {
      this.urcPrefixes.add(prefix)
    }
  }

  /**
   * Mark the channel as unresponsive. All future execute() calls
   * reject immediately with ChannelUnresponsiveError.
   *
   * Used when init detects that firmware is hung (e.g. Balong TAF
   * without SIM) — avoids waiting for individual command timeouts.
   */
  markUnresponsive(): void {
    this.unresponsive = true
  }

  /** Set a callback invoked when consecutive timeouts reach the threshold. */
  setOnUnresponsive(callback: () => void): void {
    this._onUnresponsive = callback
  }

  /** Reset the consecutive timeout counter. Called after init to prevent carry-over. */
  resetConsecutiveTimeouts(): void {
    this.consecutiveTimeouts = 0
  }

  /**
   * Reset channel state for transport reopen.
   * Clears queue (rejecting pending), resets state to idle, resets counters
   * and unresponsive flag. Unlike dispose(), the channel remains usable.
   */
  reset(): void {
    this.clearTimer()
    this.consecutiveTimeouts = 0
    this.unresponsive = false
    this.state = 'idle'
    this.currentResponseLines = []
    this.resyncing = false
    this.lineAssembler.reset()

    const error = new ChannelDisposedError()

    if (this.currentEntry) {
      this.currentEntry.reject(error)
      this.currentEntry = null
    }
    for (const entry of this.queue) {
      entry.reject(error)
    }
    this.queue.length = 0
  }

  /** Dispose the channel: cancel pending commands, clear timers */
  dispose(): void {
    this.disposed = true
    this.clearTimer()

    const error = new ChannelDisposedError()

    if (this.currentEntry) {
      this.currentEntry.reject(error)
      this.currentEntry = null
    }

    for (const entry of this.queue) {
      entry.reject(error)
    }
    this.queue.length = 0

    this.state = 'idle'
    this.currentResponseLines = []
    this.resyncing = false
    this.lineAssembler.reset()
  }

  // ── Private ────────────────────────────────────────────────────────────

  private processQueue(): void {
    if (this.disposed || this.state !== 'idle' || this.queue.length === 0) {
      return
    }

    const entry = this.queue.shift()
    if (entry === undefined) return
    this.currentEntry = entry
    this.currentResponseLines = []

    if (entry.command.expectsPrompt) {
      this.state = 'awaiting_prompt'
    } else {
      this.state = 'command_sent'
    }

    this.commandStartTime = Date.now()

    // Start timeout
    this.commandTimer = setTimeout(() => {
      this.handleTimeout()
    }, entry.command.timeout)

    this._log.trace('AT TX', {
      cmd: maskAtSecrets(entry.command.raw),
      timeout: entry.command.timeout,
    })

    // Write command to transport.
    // Catch write errors (e.g. transport closed after USB disconnect) and reject
    // the command promise so callers get a proper error instead of an unhandled rejection.
    this.transport.write(`${entry.command.raw}\r`).catch((err: unknown) => {
      // A slow write can reject after this command already timed out and the
      // queue advanced. If we're no longer the current entry, another command
      // owns the channel state — touching it here would clear its timer and
      // orphan its promise. The already-settled `entry` needs nothing further.
      if (this.currentEntry !== entry) return
      this.clearTimer()
      this.state = 'idle'
      this.currentEntry = null
      this._log.warn('AT write failed', {
        cmd: maskAtSecrets(entry.command.raw),
        error: String(err),
      })
      entry.reject(err instanceof Error ? err : new Error('Transport write failed'))
      this.processQueue()
    })
  }

  private handleLine(line: string): void {
    const suppressURC = this.currentEntry?.command.suppressURC === true
    const context = {
      currentCommand: this.currentEntry?.command.raw ?? null,
      urcPrefixes: suppressURC ? EMPTY_URC_SET : this.urcPrefixes,
    }

    const parsed = parseLine(line, context)
    this._log.trace('AT RX', { line: maskAtSecrets(line), type: parsed.type })

    // With echo on, the modem echoes the PDU data after the '>' prompt. The
    // parser can't see promptData, so it would misclassify the echoed hex as an
    // info response — discard it here.
    if (this.state === 'data_input' && this.currentEntry?.command.promptData === line) {
      return
    }

    // Resync after a timeout: the timed-out command's response may still be in
    // flight. Discard everything until the CURRENT command's echo marks the start
    // of its own response, so a late `OK` can't resolve the wrong command. URCs
    // are unsolicited and always dispatched.
    if (this.resyncing && parsed.type !== 'urc') {
      if (parsed.type === 'echo') {
        this.resyncing = false
        this._log.debug('Resynced on command echo', { line })
      }
      return
    }

    switch (parsed.type) {
      case 'empty':
      case 'echo':
        break

      case 'urc':
        this.dispatchURC({
          prefix: parsed.prefix,
          body: parsed.body,
          raw: parsed.raw,
        })
        break

      case 'info_response':
        this.currentResponseLines.push(parsed.raw)
        break

      case 'final_result':
        this.resolveCommand(parsed.result, parsed.raw)
        break

      case 'prompt':
        // Handled by handlePrompt() via LineAssembler
        break
    }
  }

  private handlePrompt(): void {
    if (this.state !== 'awaiting_prompt' || !this.currentEntry) {
      return
    }

    const entry = this.currentEntry
    const promptData = entry.command.promptData
    if (promptData !== undefined) {
      // Send PDU data followed by Ctrl-Z (0x1A)
      this.state = 'data_input'
      this.transport.write(`${promptData}\x1a`).catch((err: unknown) => {
        // See the write-error handler in processQueue: guard against clobbering
        // a different command if this rejects after `entry` was already settled.
        if (this.currentEntry !== entry) return
        this.clearTimer()
        this.state = 'idle'
        this.currentEntry = null
        entry.reject(err instanceof Error ? err : new Error('Transport write failed during prompt'))
        this.processQueue()
      })
    }
  }

  private resolveCommand(result: ATResultCode, _raw: string): void {
    if (!this.currentEntry) return

    this.clearTimer()

    const entry = this.currentEntry
    const durationMs = Date.now() - this.commandStartTime
    this.currentEntry = null
    this.state = 'idle'

    const commandResult: ATCommandResult = {
      command: entry.command.raw,
      status: result,
      lines: [...this.currentResponseLines],
    }
    this.currentResponseLines = []

    this._log.debug('AT complete', {
      cmd: maskAtSecrets(entry.command.raw),
      result: result.type,
      lines: commandResult.lines.length,
      durationMs,
    })

    if (result.type === 'ok') {
      entry.resolve(commandResult)
    } else {
      entry.reject(new ATError(entry.command.raw, result))
    }

    // Process next command in queue
    this.processQueue()
  }

  private handleTimeout(): void {
    if (!this.currentEntry) return

    const entry = this.currentEntry
    this.currentEntry = null
    this.state = 'idle'
    this.currentResponseLines = []
    this.commandTimer = null

    // Attempt to realign the stream on the next command's echo. If we were
    // ALREADY resyncing, the echo never arrived (the device isn't echoing), so
    // give up rather than discard every future command's response — degrading to
    // best-effort instead of wedging the channel.
    this.resyncing = !this.resyncing

    this.consecutiveTimeouts++
    this._log.warn('AT timeout', {
      cmd: entry.command.raw,
      timeout: entry.command.timeout,
      consecutiveTimeouts: this.consecutiveTimeouts,
    })
    entry.reject(new TimeoutError(entry.command.raw, entry.command.timeout))

    if (this.consecutiveTimeouts >= this._consecutiveTimeoutThreshold) {
      this._log.error('Channel unresponsive: consecutive timeout threshold reached', {
        threshold: this._consecutiveTimeoutThreshold,
      })
      // Reset counter so the callback doesn't re-fire for every subsequent timeout.
      // Modem's reconnect loop guards against duplicate reconnect via _reconnectingAdapters.
      this.consecutiveTimeouts = 0
      this._onUnresponsive?.()
    }

    // Process next command
    this.processQueue()
  }

  private dispatchURC(urc: URC): void {
    this._log.debug('URC', { prefix: urc.prefix, body: urc.body })
    const handlers = this.urcHandlers.get(urc.prefix)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(urc)
        } catch (err: unknown) {
          this._log.error('URC handler threw', {
            prefix: urc.prefix,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    for (const handler of this.catchAllHandlers) {
      try {
        handler(urc)
      } catch (err: unknown) {
        this._log.error('URC catch-all handler threw', {
          prefix: urc.prefix,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private resolveTimeout(command: string): number {
    // Check per-command overrides (match by prefix)
    const upper = command.toUpperCase()
    for (const [prefix, timeout] of Object.entries(this.commandTimeouts)) {
      if (upper.startsWith(prefix.toUpperCase())) {
        return timeout
      }
    }
    return this.defaultTimeout
  }

  private clearTimer(): void {
    if (this.commandTimer !== null) {
      clearTimeout(this.commandTimer)
      this.commandTimer = null
    }
  }
}
