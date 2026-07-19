import { EventEmitter } from 'node:events'
import type { ProvisionResult } from './discovery/provisioner.js'
import type { DiscoveredModem } from './discovery/usb-types.js'
import { DiscoveryError, NotSupportedError, PreparationError, TransportError } from './errors.js'
import type { Logger } from './logger.js'
import { noopLogger } from './logger.js'
import type { RemediationPolicy } from './preparation/remediation-runner.js'
import type { PrepReport } from './preparation/types.js'
import type {
  Capabilities,
  Data,
  Device,
  Network,
  Phonebook,
  ProtocolAdapter,
  Radio,
  ServiceRouteInfo,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  Traffic,
  Ussd,
  VendorPlugin,
  Voice,
} from './protocols/adapter.js'
import { AtAdapter } from './protocols/at/index.js'
import { genericProfile } from './protocols/at/profile.js'
import { type ReconnectConfig, resolveReconnectConfig, startReconnectLoop } from './reconnector.js'
import { routeServices } from './service-router.js'
import type {
  AvailableNetwork,
  ConnectionProgress,
  DeviceProfile,
  DeviceProfilePatches,
  ModelInfo,
  ModemEventMap,
  Transport,
} from './types.js'
import { DEFAULT_RESOLVERS, DEFAULT_VENDORS } from './vendor-registry.js'

export { DEFAULT_RESOLVERS, DEFAULT_VENDORS }

/** Options shared by detect() and connectFromPrepared(). */
export interface ConnectOptions {
  readonly vendors?: ReadonlyMap<string, VendorPlugin> | undefined
  readonly profile?: DeviceProfile | undefined
  readonly autoInit?: boolean | undefined
  readonly defaultTimeout?: number | undefined
  readonly logger?: Logger | undefined
  readonly onProgress?: ((event: ConnectionProgress) => void) | undefined
  /**
   * Remediation policy for the preparation pipeline — controls which
   * recoverability levels auto-apply. Pass `false` to detect and report only
   * (apply nothing), or a custom RemediationPolicy.
   * @default apply software-reversible fixes only
   */
  readonly remediation?: RemediationPolicy | false | undefined
}

// ── Modem Options ───────────────────────────────────────────────────────────

export interface ModemOptions {
  /** Serial port path, e.g. '/dev/ttyUSB0' or 'COM3' */
  readonly path: string
  /** Baud rate. @default 115200 */
  readonly baudRate?: number | undefined
  /** Default command timeout in milliseconds. @default 10000 */
  readonly defaultTimeout?: number | undefined
  /** Custom transport (overrides path/baudRate if provided) */
  readonly transport?: Transport | undefined
  /** Modem profile for vendor-specific behavior */
  readonly profile?: DeviceProfile | undefined
  /** Per-model metadata (auto-populated by Modem.detect(), manual for Modem.open()) */
  readonly model?: ModelInfo | undefined
  /**
   * Active vendor plugin for this modem.
   * Auto-populated by Modem.detect(); pass explicitly when using Modem.open() with a
   * vendor-specific profile (e.g. a Huawei device opened via serial port directly).
   */
  readonly plugin?: VendorPlugin | undefined
  /** Whether to send initialization commands on open. @default true */
  readonly autoInit?: boolean | undefined
  /**
   * Reconnect behavior after an unexpected disconnect.
   *
   * - `true` (default) — auto-reconnect with built-in defaults (3 s delay, infinite retries)
   * - `false` — no auto-reconnect; only `disconnect` event is emitted
   * - object — custom settings; any omitted fields use their defaults
   */
  readonly reconnect?:
    | boolean
    | { readonly delay?: number; readonly maxAttempts?: number }
    | undefined
  /**
   * Additional protocol adapters to include alongside the primary adapter.
   * Adapters are tried in order — first one that provides a service wins.
   * Injected by Modem.detect() when multiple protocols are discovered.
   */
  readonly extraAdapters?: readonly ProtocolAdapter[] | undefined
  /** Structured logger for debug output. Defaults to noopLogger (zero overhead). */
  readonly logger?: Logger | undefined
  /** Progress callback for connection status (retries, phases). */
  readonly onProgress?: ((event: ConnectionProgress) => void) | undefined
}

// ── Typed event declarations ──────────────────────────────────────────────────

export declare interface Modem {
  on<K extends keyof ModemEventMap>(event: K, listener: (...args: ModemEventMap[K]) => void): this
  emit<K extends keyof ModemEventMap>(event: K, ...args: ModemEventMap[K]): boolean
}

/**
 * The main entry point for cellary.
 *
 * Routes each service call to the best available protocol adapter. A device
 * may expose one or more protocols simultaneously (AT over serial/USB,
 * vendor HTTP API over CDC-ECM) — Modem selects the optimal adapter per service.
 *
 * @example
 * ```ts
 * const modem = await Modem.open('/dev/ttyUSB0')
 *
 * await modem.sms.send('+1234567890', 'Hello from cellary')
 *
 * modem.on('sms:received', (msg) => {
 *   console.log(`New SMS at index ${msg.index}`)
 * })
 *
 * const signal = await modem.network.signal()
 * console.log(`${signal.rssi} dBm`)
 *
 * await modem.close()
 * ```
 */
export class Modem extends EventEmitter {
  readonly sms: Sms
  readonly voice: Voice
  readonly network: Network
  readonly sim: Sim
  readonly ussd: Ussd
  readonly device: Device
  readonly traffic: Traffic
  readonly data: Data
  readonly radio: Radio
  readonly capabilities: Capabilities
  readonly stk: Stk
  readonly phonebook: Phonebook
  readonly system: System
  readonly thermal: Thermal

  /** Per-model metadata, if known. Undefined for generic/unknown models. */
  readonly model: ModelInfo | undefined

  /** Active vendor plugin for this modem. Available after Modem.detect() or when passed via ModemOptions. */
  readonly plugin: VendorPlugin | undefined

  private readonly _adapters: readonly ProtocolAdapter[]
  private readonly _routeInfo: Readonly<Record<string, ServiceRouteInfo>>
  private readonly _reconnect: ReconnectConfig
  private readonly _log: Logger
  /** Cleanup functions to remove event handlers we attached to adapters. */
  private readonly _eventCleanups: Array<() => void> = []
  private _reconnectAbort: AbortController | undefined
  private readonly _reconnectingAdapters = new Set<ProtocolAdapter>()
  private _closed = false
  private _report: PrepReport | undefined

  /** Preparation report from health checks run during detect(). Undefined for manual open(). */
  get preparation(): PrepReport | undefined {
    return this._report
  }

  private constructor(
    adapters: readonly ProtocolAdapter[],
    model: ModelInfo | undefined,
    reconnect: ReconnectConfig,
    plugin?: VendorPlugin,
    logger?: Logger,
  ) {
    super()
    this._log = logger ?? noopLogger
    this._adapters = adapters
    this.model = model
    this._reconnect = reconnect
    this.plugin = plugin

    this._log.info('Modem created', { protocols: adapters.map((a) => a.kind), model: model?.name })

    // Route each service to the best adapter by declared priority
    const routed = routeServices(adapters, this.protocols, this._log)
    this.network = routed.network
    this.sms = routed.sms
    this.sim = routed.sim
    this.device = routed.device
    this.voice = routed.voice
    this.ussd = routed.ussd
    this.traffic = routed.traffic
    this.data = routed.data
    this.radio = routed.radio
    this.capabilities = routed.capabilities
    this.stk = routed.stk
    this.phonebook = routed.phonebook
    this.system = routed.system
    this.thermal = routed.thermal
    this._routeInfo = routed.routeInfo

    // Forward domain events and start background activity for all adapters.
    // Every EventEmitter-based adapter is treated equally.
    // Cleanup functions are stored for targeted removal in close().
    for (const adapter of adapters) {
      if (adapter instanceof EventEmitter) {
        this._forwardEvent(adapter, 'sms:received', 'sms:received')
        this._forwardEvent(adapter, 'call:state', 'call:state')
        this._forwardEvent(adapter, 'network:registration', 'network:registration')
        this._forwardEvent(adapter, 'sim:state', 'sim:state')
        this._forwardEvent(adapter, 'call:supplementary', 'call:supplementary')
        this._forwardEvent(adapter, 'indicator:change', 'indicator:change')
        this._forwardEvent(adapter, 'raw', 'debug:raw')
      }
      adapter.start?.()
    }

    // Wire disconnect for every adapter that supports it.
    // Each adapter reconnects independently via per-adapter tracking.
    for (const adapter of adapters) {
      adapter.onDisconnect?.(() => {
        if (this._closed) return
        if (this._reconnectingAdapters.has(adapter)) return
        if (reconnect.enabled) {
          this._startReconnect(adapter).catch((err: unknown) => {
            this._reconnectingAdapters.delete(adapter)
            this.emit(
              'error',
              err instanceof Error ? err : new TransportError('Reconnect loop failed'),
            )
          })
        } else {
          this.emit('disconnect')
        }
      })
    }
  }

  /** Open a modem connection */
  static async open(options: ModemOptions): Promise<Modem>
  static async open(path: string, options?: Partial<ModemOptions>): Promise<Modem>
  static async open(
    pathOrOptions: string | ModemOptions,
    maybeOptions?: Partial<ModemOptions>,
  ): Promise<Modem> {
    const opts: ModemOptions =
      typeof pathOrOptions === 'string' ? { path: pathOrOptions, ...maybeOptions } : pathOrOptions

    const model = opts.model
    const baseProfile = opts.profile ?? genericProfile
    const profile = mergeProfile(baseProfile, model?.profilePatches)
    const log = opts.logger ?? noopLogger

    const adapterOpts = {
      defaultTimeout: opts.defaultTimeout,
      logger: log.child({ adapter: 'at' }),
    }

    let atAdapter: ProtocolAdapter
    if (opts.transport !== undefined) {
      // Custom transport (e.g. MockTransport for testing)
      atAdapter = await AtAdapter.connectWithTransport(opts.transport, profile, adapterOpts, model)
    } else {
      // Standard serial path
      const config = { type: 'serial' as const, path: opts.path, baudRate: opts.baudRate }
      atAdapter = await AtAdapter.connect(config, profile, adapterOpts, model)
    }

    const reconnect = resolveReconnectConfig(opts.reconnect)
    const adapters = [...(opts.extraAdapters ?? []), atAdapter]
    const modem = new Modem(adapters, model, reconnect, opts.plugin, log)

    if (opts.autoInit !== false) {
      try {
        await modem.init(opts.onProgress)
      } catch (err) {
        // init failed but the transport is already open — tear it down so the
        // caller can retry without hitting EBUSY on the port we still hold.
        // 'open' was never emitted, so no external listener observes this close.
        try {
          await modem.close()
        } catch (closeErr) {
          log.error('Failed to close modem after init failure', { error: closeErr })
        }
        throw err
      }
    }

    modem.emit('open')
    return modem
  }

  /**
   * Auto-detect a connected modem, mode-switch if needed, and open it.
   *
   * This is the plug-and-play API: plug in a modem, call detect(), and start
   * talking to it. Mode switching, interface detection, and profile selection
   * are all handled automatically. Works with USB direct, serial port, and
   * vendor HTTP API modems.
   *
   * @example
   * ```ts
   * const modem = await Modem.detect()
   * console.log(await modem.device.info())
   * await modem.close()
   * ```
   */
  static async detect(modem?: DiscoveredModem, options?: ConnectOptions): Promise<Modem> {
    const log = options?.logger ?? noopLogger

    // Dynamic import to avoid loading discovery code when not needed
    const { provision } = await import('./discovery/provisioner.js')
    log.info('Provisioning modem', { hasTarget: modem !== undefined })
    options?.onProgress?.({ phase: 'discovering', message: 'Discovering modem' })
    const prepared = await provision(modem)

    return Modem.connectFromPrepared(prepared, options)
  }

  /**
   * Open a modem from an already-resolved ProvisionResult.
   *
   * This is the composable building block: does everything detect() does
   * after the provision() step -- plugin discovery, adapter creation, init,
   * health checks, and verdict evaluation.
   *
   * Used by ModemPool to split the pipeline into discrete stages
   * (provision runs in 'provisioning', this runs in 'connecting' + 'checking').
   */
  static async connectFromPrepared(
    prepared: ProvisionResult,
    options?: ConnectOptions,
  ): Promise<Modem> {
    const log = options?.logger ?? noopLogger
    const profile = options?.profile ?? prepared.profile
    const vendors = options?.vendors ?? DEFAULT_VENDORS
    const adapterOpts = { defaultTimeout: options?.defaultTimeout, logger: log }

    // O(1) vendor plugin lookup by vendorId
    const profileVendorId = prepared.profile.vendorId
    const matchedPlugin = profileVendorId !== undefined ? vendors.get(profileVendorId) : undefined

    let adapters: readonly ProtocolAdapter[]
    // Model may be overridden by the plugin at runtime (shared USB PIDs)
    let resolvedModel = prepared.model

    if (matchedPlugin !== undefined) {
      // Plugin owns all adapter creation — it decides which protocols are available
      // for this hardware and in what priority order.
      const discovery = await matchedPlugin.discoverAdapters(
        prepared.transport,
        profile,
        prepared.model,
        adapterOpts,
      )
      adapters = discovery.adapters
      if (discovery.model !== undefined) resolvedModel = discovery.model
      if (adapters.length === 0) {
        throw new DiscoveryError(
          `Plugin '${matchedPlugin.name}' returned no adapters for this device. ` +
            'The device may be unreachable or in an unsupported mode.',
        )
      }
    } else if (prepared.driver.kind === 'at' && prepared.transport.type !== 'http') {
      // Generic device with no matching plugin — fall back to AT only
      adapters = [await AtAdapter.connect(prepared.transport, profile, adapterOpts)]
    } else {
      const api = prepared.driver.kind === 'vendor' ? prepared.driver.api : prepared.transport.type
      throw new DiscoveryError(
        `No plugin registered for '${api}'. ` +
          'Register a vendor plugin via Modem.detect(undefined, { vendors: [...] }).',
      )
    }

    // Enable reconnect only when at least one adapter supports disconnect notifications
    const anyCanDisconnect = adapters.some((a) => a.onDisconnect !== undefined)
    const reconnect = resolveReconnectConfig(anyCanDisconnect ? undefined : false)

    const instance = new Modem(adapters, resolvedModel, reconnect, matchedPlugin, log)

    const onProgress = options?.onProgress

    if (options?.autoInit !== false) {
      try {
        onProgress?.({ phase: 'initializing', message: 'Initializing modem' })
        await instance.init(onProgress)

        // Run preparation health checks after modem is live.
        // Dynamic import keeps preparation code out of the main bundle
        // when not using detect().
        onProgress?.({ phase: 'checking', message: 'Running health checks' })
        const { resolveProfile } = await import('./preparation/profiles.js')
        const { runPreparation } = await import('./preparation/runner.js')

        const transportVendor = prepared.transport.type === 'usb' ? prepared.transport.vendorId : 0
        const transportProduct =
          prepared.transport.type === 'usb' ? prepared.transport.productId : 0
        const deviceInfo = {
          name: resolvedModel?.name ?? 'Unknown',
          vendorId: transportVendor,
          productId: transportProduct,
        }

        const prepProfile = resolveProfile(deviceInfo, matchedPlugin, resolvedModel)
        const remediationPolicy =
          options?.remediation === false ? { autoApply: [] } : options?.remediation
        const report = await runPreparation(
          instance,
          prepProfile,
          deviceInfo,
          log,
          remediationPolicy,
        )
        instance._report = report

        if (report.verdict === 'failed') {
          throw new PreparationError(report)
        }
      } catch (err) {
        // init or health checks failed after the transport was opened — tear it
        // down (single close path for every failure, including 'failed' verdict)
        // so a retry doesn't hit EBUSY. 'open' was never emitted.
        try {
          await instance.close()
        } catch (closeErr) {
          log.error('Failed to close modem after connect failure', { error: closeErr })
        }
        throw err
      }
    }

    // Emit 'open' only after health checks pass (or when skipping init
    // for diagnostic modes where partial connectivity is acceptable).
    instance.emit('open')

    return instance
  }

  /** Close the modem connection */
  async close(): Promise<void> {
    this._closed = true

    // Cancel any in-flight reconnect loop immediately
    this._reconnectAbort?.abort()
    this._reconnectAbort = undefined

    this.stk.disable()

    // Remove only the event handlers we attached (not all listeners on the adapter)
    for (const fn of this._eventCleanups) {
      fn()
    }
    this._eventCleanups.length = 0

    // Close every adapter even if one throws — a failure in one must not leak
    // the others (they may share a USB device via ref-counted acquisition).
    for (const adapter of this._adapters) {
      adapter.stop?.()
      try {
        await adapter.close?.()
      } catch (err: unknown) {
        this._log.warn('Adapter close failed', {
          adapter: adapter.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.emit('close')
  }

  /**
   * Hardware-reset the modem via USB bus reset.
   *
   * Resets the first adapter that supports it (typically AT over USB).
   * After reset the modem is closed and unusable — the device will
   * re-enumerate on the USB bus in ~2-3 seconds and must be re-discovered.
   *
   * This is the software equivalent of unplugging and re-plugging the USB cable.
   * Use it to recover from a stuck AT channel (all commands timing out).
   */
  async resetTransport(): Promise<void> {
    // Find an adapter that supports hardware reset
    for (const adapter of this._adapters) {
      if (adapter.reset !== undefined) {
        this._log.info('Resetting transport', { adapter: adapter.kind })
        await adapter.reset()
        this._closed = true
        this.emit('close')
        return
      }
    }
    throw new TransportError('No adapter supports hardware reset')
  }

  /** Whether the transport is currently open */
  get isOpen(): boolean {
    return !this._closed
  }

  /** Active protocol adapters by kind (e.g. ['at', 'http']). Priority-ordered: index 0 wins per service. */
  get protocols(): readonly string[] {
    return this._adapters.map((a) => a.kind)
  }

  /** Base URL of the first HTTP-based adapter, if any. Undefined for serial/USB-only connections. */
  get httpUrl(): string | undefined {
    for (const adapter of this._adapters) {
      if (adapter.baseUrl !== undefined) return adapter.baseUrl
    }
    return undefined
  }

  /** Routing decision metadata per service: which adapter, why, was it contested. */
  get serviceRouting(): Readonly<Record<string, ServiceRouteInfo>> {
    return this._routeInfo
  }

  /** Access a specific protocol adapter by kind (e.g. 'at', 'http', 'adb'). */
  adapter(kind: string): ProtocolAdapter | undefined {
    return this._adapters.find((a) => a.kind === kind)
  }

  // ── Network scan & selection ──────────────────────────────────────────────
  //
  // These methods search ALL adapters for the capability, not just the primary
  // network adapter. The primary adapter wins for signal/registration quality,
  // but scan/select may only be available on a different adapter (e.g. one
  // protocol supports scanning while another does not).

  /** Scan for available networks. Slow: typically 30-120 seconds. */
  async scanNetworks(): Promise<AvailableNetwork[]> {
    const net = this._findNetworkMethod('scan')
    if (net === undefined) throw new NotSupportedError('network scan', this.protocols)
    return net.scan()
  }

  /** Manually select a network by PLMN code (e.g. "28301"). */
  async selectNetwork(plmn: string): Promise<void> {
    const net = this._findNetworkMethod('selectOperator')
    if (net === undefined) throw new NotSupportedError('network select', this.protocols)
    return net.selectOperator(plmn)
  }

  /** Return to automatic network selection. */
  async selectNetworkAutomatic(): Promise<void> {
    const net = this._findNetworkMethod('selectAutomatic')
    if (net === undefined) throw new NotSupportedError('network select', this.protocols)
    return net.selectAutomatic()
  }

  /** Find the first adapter whose network service has the given method. */
  private _findNetworkMethod<M extends 'scan' | 'selectOperator' | 'selectAutomatic'>(
    method: M,
  ): (Network & Required<Pick<Network, M>>) | undefined {
    for (const adapter of this._adapters) {
      const net = adapter.network
      if (net !== undefined && hasNetworkMethod(net, method)) {
        return net
      }
    }
    return undefined
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to an adapter event and forward it on this Modem.
   * Stores a cleanup function so close() removes only our handler.
   */
  private _forwardEvent(adapter: EventEmitter, fromEvent: string, toEvent: string): void {
    const handler = (...args: unknown[]) => {
      // Call base EventEmitter.emit to bypass typed overloads —
      // we're forwarding dynamically by event name.
      EventEmitter.prototype.emit.call(this, toEvent, ...args)
    }
    adapter.on(fromEvent, handler)
    this._eventCleanups.push(() => {
      adapter.removeListener(fromEvent, handler)
    })
  }

  private async _startReconnect(adapter: ProtocolAdapter): Promise<void> {
    this._reconnectingAdapters.add(adapter)
    this._log.warn('Transport disconnected', { adapter: adapter.kind })

    // Emit disconnect only for the first adapter entering the reconnect loop
    if (this._reconnectingAdapters.size === 1) {
      this.emit('disconnect')
    }

    const abort = new AbortController()
    this._reconnectAbort = abort

    await startReconnectLoop(adapter, this._reconnect, this._log, abort, {
      onReconnect: () => {
        this._reconnectingAdapters.delete(adapter)
        this.emit('reconnect')
      },
      onFailed: (_adapter, attempts) => {
        this._reconnectingAdapters.delete(adapter)
        this.emit('reconnect:failed')
        this.emit(
          'error',
          new TransportError(
            `Reconnect failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
          ),
        )
      },
      isClosed: () => this._closed,
    })
  }

  private async init(onProgress?: (event: ConnectionProgress) => void): Promise<void> {
    // Non-fatal init failures go to logger, not EventEmitter.
    // Emitting 'error' here would crash: no listeners are attached yet
    // (Modem.open/detect haven't returned to the caller).
    // Fatal failures (e.g. probe timeout) throw and propagate to the caller.
    const onError = (step: string, err: Error) =>
      this._log.warn(`Init step failed: ${step}`, { error: err.message })
    for (const adapter of this._adapters) {
      await adapter.init?.(onError, onProgress)
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Type guard: narrows Network to include a required optional method. */
function hasNetworkMethod<M extends keyof Network>(
  net: Network,
  method: M,
): net is Network & Required<Pick<Network, M>> {
  return net[method] !== undefined
}

// ── Profile Merging ────────────────────────────────────────────────────────

/**
 * Merge a model's profile patches on top of a vendor profile.
 *
 * - `extraInitCommands` are appended after the vendor's init sequence
 * - `commandTimeouts` and `commands` are spread on top (model wins)
 *
 * Returns the base profile unchanged if no patches are provided.
 * Only patches the AT config; identity fields (vendorId, name) are preserved.
 */
function mergeProfile(
  base: DeviceProfile,
  patches: DeviceProfilePatches | undefined,
): DeviceProfile {
  if (patches === undefined) return base

  const atPatches = patches.at
  if (atPatches === undefined || base.at === undefined) return base

  return {
    ...base,
    at: {
      ...base.at,
      initCommands:
        atPatches.extraInitCommands !== undefined
          ? [...base.at.initCommands, ...atPatches.extraInitCommands]
          : base.at.initCommands,
      commandTimeouts:
        atPatches.commandTimeouts !== undefined
          ? { ...base.at.commandTimeouts, ...atPatches.commandTimeouts }
          : base.at.commandTimeouts,
      commands:
        atPatches.commands !== undefined
          ? { ...base.at.commands, ...atPatches.commands }
          : base.at.commands,
    },
  }
}
