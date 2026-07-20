import { EventEmitter } from 'node:events'
import type { AuditSink } from '../../audit.js'
import { ATError, TimeoutError, TransportError } from '../../errors.js'
import type { Logger } from '../../logger.js'
import { SerialTransport } from '../../transport/serial.js'
import { UsbTransport } from '../../transport/usb.js'
import type {
  CallEvent,
  IndicatorChangeEvent,
  ModelInfo,
  RegistrationInfo,
  SimStateEvent,
  SmsNotification,
  SsNotificationEvent,
  Transport,
  TransportConfig,
  UnsolicitedMessage,
} from '../../types.js'
import { sleep } from '../../utils.js'
import type {
  Capabilities,
  Data,
  Device,
  Network,
  Phonebook,
  ProtocolAdapter,
  Radio,
  ServiceCapability,
  ServiceName,
  Sim,
  Sms,
  Stk,
  Traffic,
  Ussd,
  VendorEvent,
  Voice,
} from '../adapter.js'
import type { ATChannel } from './channel/at-channel.js'
import { ATChannel as ATChannelClass } from './channel/at-channel.js'
import { CapabilitiesModule } from './services/capabilities.js'
import { DataModule } from './services/data.js'
import { DeviceModule } from './services/device.js'
import { NetworkModule } from './services/network.js'
import { PhonebookModule } from './services/phonebook.js'
import { RadioModule } from './services/radio.js'
import { SimModule } from './services/sim.js'
import { SmsModule } from './services/sms/index.js'
import { StkModule } from './services/stk/index.js'
import { TrafficModule } from './services/traffic.js'
import { UssdModule } from './services/ussd.js'
import { VoiceModule } from './services/voice.js'
import type { ATCommand, ATCommandResult, AtConfig, DeviceProfile, URC } from './types.js'
import { setupUrcHandlers } from './urc-handlers.js'

// ── Typed event declarations ──────────────────────────────────────────────────

/**
 * Typed event overloads for AtAdapter.
 * Follows the standard Node.js declare-interface pattern for typed EventEmitters.
 */
export declare interface AtAdapter {
  on(event: 'sms:received', listener: (n: SmsNotification) => void): this
  on(event: 'call:state', listener: (info: CallEvent) => void): this
  on(event: 'call:supplementary', listener: (notification: SsNotificationEvent) => void): this
  on(event: 'network:registration', listener: (info: RegistrationInfo) => void): this
  on(event: 'sim:state', listener: (info: SimStateEvent) => void): this
  on(event: 'indicator:change', listener: (change: IndicatorChangeEvent) => void): this
  on(event: 'raw', listener: (message: URC) => void): this
  on(event: string, listener: (...args: unknown[]) => void): this
}

/** Function that interprets a raw message into a typed domain event. */
export type MessageInterpreter = (message: UnsolicitedMessage) => VendorEvent | undefined

export interface AtConnectOptions {
  readonly defaultTimeout?: number | undefined
  readonly commandTimeouts?: Readonly<Record<string, number>> | undefined
  readonly logger?: Logger | undefined
  readonly auditSink?: AuditSink | undefined
  /** Vendor-specific message interpreter. Injected by vendor plugins to translate raw messages into typed domain events. */
  readonly messageInterpreter?: MessageInterpreter | undefined
}

/**
 * AT command protocol adapter.
 *
 * Implements all service interfaces via 3GPP AT commands over serial/USB.
 * Also parses AT URCs and emits domain-level events that Modem forwards to users.
 */
export class AtAdapter extends EventEmitter implements ProtocolAdapter {
  readonly kind = 'at' as const

  readonly network: Network
  readonly sms: Sms
  readonly sim: Sim
  readonly device: Device
  readonly voice: Voice
  readonly ussd: Ussd
  readonly stk: Stk
  readonly data: Data
  readonly radio: Radio
  readonly phonebook: Phonebook
  readonly traffic: Traffic | undefined
  readonly capabilities: Capabilities

  /** Concrete SimModule reference for init-time knowledge sharing. */
  private readonly _simModule: SimModule
  /** Concrete DeviceModule reference for indicator name resolution in CIEV handler. */
  private readonly _deviceModule: DeviceModule

  /** The AT command configuration for this device */
  private readonly _atConfig: AtConfig
  /** Stored so channel health can trigger the same handler as transport disconnect. */
  private _disconnectHandler: (() => void) | undefined

  /**
   * Create and open an AT adapter for a serial or USB transport.
   *
   * Opens the physical transport. Does NOT send init commands — call init()
   * separately so callers can control sequencing (e.g. skip during tests).
   *
   * Takes a DeviceProfile and extracts the AT config. Throws if the profile
   * has no AT config (HTTP-only devices should not use AtAdapter).
   */
  static async connect(
    config: TransportConfig & { readonly type: 'serial' | 'usb' },
    profile: DeviceProfile,
    opts: AtConnectOptions = {},
    model?: ModelInfo,
  ): Promise<AtAdapter> {
    const transport =
      config.type === 'serial'
        ? new SerialTransport({ path: config.path, baudRate: config.baudRate })
        : new UsbTransport({
            vendorId: config.vendorId,
            productId: config.productId,
            interfaceNumber: config.interfaceNumber,
            assertDtr: config.assertDtr,
          })
    return AtAdapter.connectWithTransport(transport, profile, opts, model)
  }

  /**
   * Create and open an AT adapter using a caller-provided transport.
   *
   * Used when the transport is already constructed (e.g. MockTransport in tests,
   * ADB serial transport). Opens the transport, creates the AT channel, and
   * returns a ready-to-init adapter.
   */
  static async connectWithTransport(
    transport: Transport,
    profile: DeviceProfile,
    opts: AtConnectOptions = {},
    model?: ModelInfo,
  ): Promise<AtAdapter> {
    const atConfig = requireAtConfig(profile)
    const channel = new ATChannelClass(transport, {
      urcPrefixes: [...atConfig.urcPrefixes],
      defaultTimeout: opts.defaultTimeout ?? 10_000,
      commandTimeouts: opts.commandTimeouts ?? atConfig.commandTimeouts,
      logger: opts.logger,
      auditSink: opts.auditSink,
    })
    await transport.open()
    return new AtAdapter(transport, channel, atConfig, model, opts.messageInterpreter)
  }

  constructor(
    private readonly _transport: Transport,
    private readonly _channel: ATChannel,
    atConfig: AtConfig,
    model: ModelInfo | undefined,
    private readonly _interpretMessage?: MessageInterpreter | undefined,
  ) {
    super()
    this._atConfig = atConfig
    this.network = new NetworkModule(_channel, atConfig)
    this.sms = new SmsModule(_channel, atConfig)
    this._simModule = new SimModule(_channel, atConfig, model)
    this.sim = this._simModule
    this._deviceModule = new DeviceModule(_channel, atConfig)
    this.device = this._deviceModule
    this.voice = new VoiceModule(_channel, atConfig)
    this.ussd = new UssdModule(_channel, atConfig)
    this.stk = new StkModule(_channel, atConfig)
    this.data = new DataModule(_channel, atConfig)
    this.radio = new RadioModule(_channel)
    this.phonebook = new PhonebookModule(_channel)
    this.traffic =
      atConfig.traffic !== undefined ? new TrafficModule(_channel, atConfig.traffic) : undefined
    this.capabilities = new CapabilitiesModule(_channel, atConfig, model)

    setupUrcHandlers({
      channel: _channel,
      deviceModule: this._deviceModule,
      emitter: this,
      interpretMessage: this._interpretMessage,
    })

    // Wire channel health monitoring to adapter disconnect
    _channel.setOnUnresponsive(() => this._disconnectHandler?.())
  }

  /**
   * Initialize the AT adapter: probe the modem, then send profile init commands.
   *
   * The probe step sends bare "AT" with retries to establish that the channel
   * is alive. Flaky hardware (overheating, slow USB enumeration) often needs
   * a few attempts before responding. If the probe fails after all retries,
   * a TransportError is thrown — the modem is not usable.
   *
   * Individual init command failures are non-fatal: reported via onError
   * and skipped. The modem may still work for some operations.
   */
  async init(
    onError?: (step: string, err: Error) => void,
    onProgress?: (event: {
      phase: string
      message: string
      attempt?: number
      maxAttempts?: number
    }) => void,
  ): Promise<void> {
    await this.probe(onError, onProgress)

    const CME_SIM_NOT_INSERTED = 10

    // Balong firmware (Huawei) hangs AT commands when the radio subsystem
    // isn't ready. Two distinct scenarios:
    //
    // 1. No SIM: ALL commands except bare AT hang. The TAF engine blocks on
    //    SIM initialization that never completes. Channel is truly unresponsive.
    //
    // 2. SIM inserted but radio not initialized: configuration commands work
    //    (ATE1, AT+CMEE, AT+CMGF) but radio-dependent commands hang (AT+CREG,
    //    AT+CGREG, AT+CLIP). Channel is partially responsive.
    //
    // The cascade detector handles both: 3 consecutive timeouts -> bail out.
    // But we only mark channel unresponsive if NO commands succeeded (scenario 1).
    // If some commands worked (scenario 2), the channel is alive -- service calls
    // may still succeed for non-radio operations.
    const MAX_CONSECUTIVE_TIMEOUTS = 3
    let consecutiveTimeouts = 0
    let anySucceeded = false

    for (const cmd of this._atConfig.initCommands) {
      try {
        await this._channel.execute(cmd)
        consecutiveTimeouts = 0
        anySucceeded = true
      } catch (err) {
        // CME ERROR 10 from any init command means SIM is not inserted.
        // Tell SimModule so it can skip AT+CPIN? (which hangs on some devices).
        if (
          err instanceof ATError &&
          err.result.type === 'cme_error' &&
          err.result.code === CME_SIM_NOT_INSERTED
        ) {
          this._simModule.markAbsent()
        }

        // Track consecutive timeouts (modem didn't respond at all)
        if (err instanceof TimeoutError) {
          consecutiveTimeouts++
        } else {
          consecutiveTimeouts = 0
        }

        onError?.(cmd, err instanceof Error ? err : new Error(String(err)))

        // 3 consecutive timeouts: remaining commands will also hang.
        // Skip them to avoid wasting time.
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          if (!anySucceeded) {
            // Scenario 1: firmware is completely unresponsive (no SIM).
            // Mark channel dead so all service calls fail instantly.
            this._simModule.markAbsent()
            this._channel.markUnresponsive()
          }
          // Scenario 2: some commands worked, just radio subsystem is stuck.
          // Leave channel alive -- non-radio queries may still work.
          break
        }
      }
    }

    // Reset runtime health counter so init-time timeouts don't carry over
    // to post-init service calls and trigger a false reconnect.
    this._channel.resetConsecutiveTimeouts()
  }

  /**
   * Probe the modem with a bare "AT" command to verify the channel is alive.
   * Retries with delay on failure. Throws TransportError if all attempts fail.
   */
  private async probe(
    onError?: (step: string, err: Error) => void,
    onProgress?: (event: {
      phase: string
      message: string
      attempt?: number
      maxAttempts?: number
    }) => void,
  ): Promise<void> {
    const PROBE_TIMEOUT = 3_000
    const MAX_ATTEMPTS = 3
    const RETRY_DELAY = 1_500

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this._channel.execute('AT', { timeout: PROBE_TIMEOUT })
        return
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const error = err instanceof Error ? err : new Error(String(err))
          onError?.(`AT probe (attempt ${attempt}/${MAX_ATTEMPTS})`, error)
          onProgress?.({
            phase: 'initializing',
            message: 'Modem not responding, retrying',
            attempt: attempt + 1,
            maxAttempts: MAX_ATTEMPTS,
          })
          await sleep(RETRY_DELAY)
        } else {
          throw new TransportError(`Modem not responding after ${MAX_ATTEMPTS} attempts`, {
            cause: err,
          })
        }
      }
    }
  }

  /** Register a handler called when the transport disconnects unexpectedly. */
  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
    this._transport.onDisconnect(handler)
  }

  /**
   * Re-open the transport after a disconnect (for reconnect logic).
   * Closes the old transport first (critical for ADB serial where open()
   * returns early if already open), resets channel state, then opens fresh.
   */
  async reopen(): Promise<void> {
    if (this._transport.isOpen) {
      await this._transport.close()
    }
    this._channel.reset()
    await this._transport.open()
  }

  /** Execute a raw AT command (delegates to the underlying channel). */
  async execute(
    command: string,
    options?: Partial<Pick<ATCommand, 'timeout' | 'expectsPrompt' | 'promptData' | 'suppressURC'>>,
  ): Promise<ATCommandResult> {
    return this._channel.execute(command, options)
  }

  /** Dispose the AT channel and close the transport. */
  async close(): Promise<void> {
    this._channel.dispose()
    if (this._transport.isOpen) {
      await this._transport.close()
    }
  }

  /**
   * Hardware-reset the underlying transport (USB bus reset).
   * Disposes the channel first, then delegates to transport.reset().
   * After this call the adapter is dead — caller must re-discover.
   */
  async reset(): Promise<void> {
    if (this._transport.reset === undefined) {
      throw new TransportError('Transport does not support hardware reset')
    }
    this._channel.dispose()
    await this._transport.reset()
  }

  serviceCapabilities(): Partial<Record<ServiceName, ServiceCapability>> {
    const caps: Partial<Record<ServiceName, ServiceCapability>> = {
      network: { priority: 5, reason: 'basic signal' },
      sms: { priority: 10, reason: '3GPP standard' },
      sim: { priority: 10, reason: '3GPP standard' },
      device: { priority: 10, reason: '3GPP standard' },
      voice: { priority: 10, reason: '3GPP standard' },
      ussd: { priority: 8, reason: 'no auth required' },
      stk: { priority: 10, reason: '3GPP standard' },
      data: { priority: 10, reason: 'full PDP context control' },
      radio: { priority: 10, reason: '3GPP standard' },
      phonebook: { priority: 10, reason: '3GPP standard' },
      capabilities: { priority: 10, reason: '3GPP standard' },
    }
    if (this.traffic !== undefined) {
      caps.traffic = { priority: 10, reason: 'vendor AT command' }
    }
    return caps
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract AtConfig from a DeviceProfile, throwing if the profile has no AT config. */
export function requireAtConfig(profile: DeviceProfile): AtConfig {
  if (profile.at === undefined) {
    throw new TransportError(
      `Profile '${profile.name}' has no AT configuration. ` +
        'AtAdapter requires a profile with AT command support.',
    )
  }
  return profile.at
}

/** Type guard: check if a protocol adapter is an AT adapter by kind. */
export function isAtAdapter(adapter: ProtocolAdapter | undefined): adapter is AtAdapter {
  return adapter !== undefined && adapter.kind === 'at'
}
