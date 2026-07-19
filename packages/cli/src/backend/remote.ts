/**
 * Remote backend: proxies all modem interactions through the daemon via IPC.
 *
 * When the daemon is running, CLI commands work without sudo -- the daemon
 * is the privileged hardware gatekeeper. RemoteBackend translates Backend/
 * DeviceHandle operations into JSON-RPC calls to the daemon.
 */

import { EventEmitter } from 'node:events'
import type {
  ActiveCall,
  AvailableNetwork,
  DataConnectionStatus,
  DeviceInfo,
  DeviceObserverOptions,
  DiscoveredModem,
  InteractiveStream,
  ModelInfo,
  ModemCapabilities,
  ModemEventMap,
  PdpContext,
  ProvisionResult,
  RegistrationInfo,
  ServiceRouteInfo,
  SignalInfo,
  SimInfo,
  SmsCount,
  SmsMessage,
  Stk,
  StkMenu,
  TrafficStats,
} from 'cellary'
import { NotSupportedError } from 'cellary'
import { z } from 'zod'
import {
  activeCallSchema,
  availableNetworkSchema,
  cpuFrequencySchema,
  dataConnectionStatusSchema,
  deviceInfoSchema,
  modemCapabilitiesSchema,
  pdpContextSchema,
  provisionResultPartialSchema,
  registrationInfoSchema,
  signalInfoSchema,
  simInfoSchema,
  smsCountSchema,
  smsMessageSchema,
  thermalReadingSchema,
  trafficStatsSchema,
} from './response-schemas.js'
import type { Backend, ConnectOptions, DeviceHandle, DeviceWatcher } from './types.js'

// ── DaemonClient import ─────────────────────────────────────────────────────

import type { IpcDeviceInfo } from '@cellary/daemon/client'
import { DaemonClient } from '@cellary/daemon/client'

// ── Validated call helper ───────────────────────────────────────────────────

/**
 * Await an RPC call and validate the response against a Zod schema.
 *
 * Replaces `as` casts by verifying the daemon response shape at runtime.
 * If the daemon sends a malformed response, this throws immediately with
 * a clear validation error rather than propagating corrupted data.
 */
async function validated<T>(promise: Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  const result = await promise
  return schema.parse(result)
}

// ── RemoteDeviceHandle ──────────────────────────────────────────────────────

type ServiceCallFn = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>

/** AT+COPS=? can take up to 120s per 3GPP. Add margin for IPC overhead. */
const NETWORK_SCAN_TIMEOUT_MS = 130_000
/** AT+COPS= manual selection can take up to 90s. */
const NETWORK_SELECT_TIMEOUT_MS = 100_000
type StreamOpenFn = (type: string) => Promise<InteractiveStream>

/**
 * Remote service proxy: each method delegates to a daemon RPC call.
 *
 * All responses are validated at runtime using Zod schemas to ensure the
 * daemon response matches the expected type. Simple void-returning methods
 * just await the call without validation.
 */
class RemoteDeviceHandle implements DeviceHandle {
  private readonly _call: ServiceCallFn
  private readonly _openStream: StreamOpenFn
  private readonly _emitter = new EventEmitter()
  private readonly _modelName: string | undefined
  private readonly _protocols: readonly string[]
  private readonly _httpUrl: string | undefined
  private readonly _serviceRouting: Readonly<Record<string, ServiceRouteInfo>>
  private _stkProxy: Stk | undefined
  private _open = true

  constructor(
    call: ServiceCallFn,
    openStream: StreamOpenFn,
    deviceMeta: {
      modelName: string | undefined
      protocols: readonly string[] | undefined
      httpUrl: string | undefined
      serviceRouting: Readonly<Record<string, ServiceRouteInfo>> | undefined
    },
  ) {
    this._call = call
    this._openStream = openStream
    this._modelName = deviceMeta.modelName
    this._protocols = deviceMeta.protocols ?? []
    this._httpUrl = deviceMeta.httpUrl
    this._serviceRouting = deviceMeta.serviceRouting ?? {}
  }

  // ── Services ──────────────────────────────────────────────────────────────

  get network() {
    const call = this._call
    return {
      async signal(): Promise<SignalInfo> {
        return validated(call('network.signal'), signalInfoSchema)
      },
      async registration(): Promise<RegistrationInfo> {
        return validated(call('network.registration'), registrationInfoSchema)
      },
      async operator(): Promise<string | undefined> {
        return validated(call('network.operator'), z.string().optional())
      },
      async scan(): Promise<AvailableNetwork[]> {
        return validated(call('network.scan'), z.array(availableNetworkSchema))
      },
      async selectOperator(plmn: string): Promise<void> {
        await call('network.selectOperator', { plmn })
      },
      async selectAutomatic(): Promise<void> {
        await call('network.selectAutomatic')
      },
    }
  }

  get sms() {
    const call = this._call
    return {
      async send(to: string, text: string): Promise<number> {
        return validated(call('sms.send', { to, text }), z.number())
      },
      async list(status?: 'all' | 'unread' | 'read' | 'sent' | 'unsent'): Promise<SmsMessage[]> {
        return validated(
          call('sms.list', status !== undefined ? { status } : {}),
          z.array(smsMessageSchema),
        )
      },
      async read(index: number): Promise<SmsMessage> {
        return validated(call('sms.read', { index }), smsMessageSchema)
      },
      async delete(index: number): Promise<void> {
        await call('sms.delete', { index })
      },
      async count(): Promise<SmsCount> {
        return validated(call('sms.count'), smsCountSchema)
      },
    }
  }

  get sim() {
    const call = this._call
    return {
      async info(): Promise<SimInfo> {
        return validated(call('sim.info'), simInfoSchema)
      },
      async iccid(): Promise<string> {
        return validated(call('sim.iccid'), z.string())
      },
      async imsi(): Promise<string> {
        return validated(call('sim.imsi'), z.string())
      },
      async enterPin(pin: string): Promise<void> {
        await call('sim.enterPin', { pin })
      },
      async phoneNumber(): Promise<string | undefined> {
        return validated(call('sim.phoneNumber'), z.string().optional())
      },
    }
  }

  get device() {
    const call = this._call
    return {
      async info(): Promise<DeviceInfo> {
        return validated(call('device.info'), deviceInfoSchema)
      },
      async imei(): Promise<string> {
        return validated(call('device.imei'), z.string())
      },
      async temperature(): Promise<number | undefined> {
        return validated(call('device.temperature'), z.number().optional())
      },
    }
  }

  get voice() {
    const call = this._call
    return {
      async dial(number: string): Promise<void> {
        await call('voice.dial', { number })
      },
      async answer(): Promise<void> {
        await call('voice.answer')
      },
      async hangup(): Promise<void> {
        await call('voice.hangup')
      },
      async dtmf(tones: string): Promise<void> {
        await call('voice.dtmf', { tones })
      },
      async listCalls(): Promise<readonly ActiveCall[]> {
        return validated(call('voice.listCalls'), z.array(activeCallSchema))
      },
    }
  }

  get ussd() {
    const call = this._call
    return {
      async send(code: string): Promise<string> {
        return validated(call('ussd.send', { code }), z.string())
      },
      async cancel(): Promise<void> {
        await call('ussd.cancel')
      },
    }
  }

  get traffic() {
    const call = this._call
    return {
      async session(): Promise<TrafficStats> {
        return validated(call('traffic.session'), trafficStatsSchema)
      },
      async monthly(): Promise<TrafficStats> {
        return validated(call('traffic.monthly'), trafficStatsSchema)
      },
    }
  }

  get data() {
    const call = this._call
    return {
      async status(): Promise<DataConnectionStatus> {
        return validated(call('data.status'), dataConnectionStatusSchema)
      },
      async contexts(): Promise<PdpContext[]> {
        return validated(call('data.contexts'), z.array(pdpContextSchema))
      },
    }
  }

  get capabilities() {
    const call = this._call
    return {
      async discover(): Promise<ModemCapabilities> {
        return validated(call('capabilities.discover'), modemCapabilitiesSchema)
      },
    }
  }

  get stk(): Stk {
    if (this._stkProxy) return this._stkProxy

    const call = this._call
    const emitter = new EventEmitter()
    let stkEnabled = false
    let stkMenu: StkMenu | undefined

    // STK state is updated via daemon events (stk:menu, stk:session:end, etc.)
    // The _handleEvent method below forwards them to this emitter.
    const proxy = Object.assign(emitter, {
      get enabled() {
        return stkEnabled
      },
      get menu() {
        return stkMenu
      },
      async enable(): Promise<void> {
        await call('stk.enable')
        stkEnabled = true
      },
      disable(): void {
        call('stk.disable').catch(() => {})
        stkEnabled = false
      },
      async select(itemId: number): Promise<void> {
        await call('stk.select', { itemId })
      },
      async confirm(): Promise<void> {
        await call('stk.confirm')
      },
      async input(text: string): Promise<void> {
        await call('stk.input', { text })
      },
      async key(char: string): Promise<void> {
        await call('stk.key', { char })
      },
      async back(): Promise<void> {
        await call('stk.back')
      },
      async endSession(): Promise<void> {
        await call('stk.endSession')
      },
    }) satisfies Stk

    // Fetch initial state from daemon
    call('stk.state')
      .then((result) => {
        const state = result as { enabled: boolean; menu?: StkMenu }
        stkEnabled = state.enabled
        stkMenu = state.menu
      })
      .catch(() => {})

    this._stkProxy = proxy
    return proxy
  }

  get system() {
    const call = this._call
    const openStream = this._openStream
    return {
      async shell(command: string): Promise<string> {
        return validated(call('system.shell', { command }), z.string())
      },
      async setTtl(ttl: number): Promise<void> {
        await call('system.setTtl', { ttl })
      },
      async getTtl(): Promise<number | undefined> {
        return validated(call('system.getTtl'), z.number().optional())
      },
      async openInteractiveShell(): Promise<InteractiveStream> {
        return openStream('shell')
      },
    }
  }

  get thermal() {
    const call = this._call
    return {
      async readSensors() {
        return validated(call('thermal.readSensors'), z.array(thermalReadingSchema))
      },
      async readCpuFrequency() {
        return validated(call('thermal.readCpuFrequency'), cpuFrequencySchema)
      },
      async setMaxFrequencyKhz(khz: number): Promise<void> {
        await call('thermal.setMaxFrequencyKhz', { khz })
      },
    }
  }

  // ── Modem-level operations ────────────────────────────────────────────────

  async scanNetworks(): Promise<AvailableNetwork[]> {
    return validated(
      this._call('network.scan', undefined, NETWORK_SCAN_TIMEOUT_MS),
      z.array(availableNetworkSchema),
    )
  }

  async selectNetwork(plmn: string): Promise<void> {
    await this._call('network.selectOperator', { plmn }, NETWORK_SELECT_TIMEOUT_MS)
  }

  async selectNetworkAutomatic(): Promise<void> {
    await this._call('network.selectAutomatic', undefined, NETWORK_SELECT_TIMEOUT_MS)
  }

  // ── Metadata ──────────────────────────────────────────────────────────────
  // Limited in remote mode -- daemon doesn't expose full modem metadata yet.

  get protocols(): readonly string[] {
    return this._protocols
  }

  get httpUrl(): string | undefined {
    return this._httpUrl
  }

  get model(): ModelInfo | undefined {
    if (this._modelName === undefined) return undefined
    return { name: this._modelName }
  }

  get serviceRouting(): Readonly<Record<string, ServiceRouteInfo>> {
    return this._serviceRouting
  }

  // ── Events ────────────────────────────────────────────────────────────────

  on<K extends keyof ModemEventMap>(event: K, listener: (...args: ModemEventMap[K]) => void): void {
    this._emitter.on(event, listener)
  }

  off<K extends keyof ModemEventMap>(
    event: K,
    listener: (...args: ModemEventMap[K]) => void,
  ): void {
    this._emitter.off(event, listener)
  }

  /** Forward a daemon event notification to local listeners. */
  _handleEvent(event: string, data: unknown): void {
    // STK events from daemon arrive as 'stk:menu', 'stk:text', etc.
    // Forward to the STK proxy's EventEmitter.
    if (event.startsWith('stk:') && this._stkProxy) {
      const stkEvent = event.slice(4) // 'stk:menu' -> 'menu'
      this._stkProxy.emit(stkEvent, data)
      return
    }
    // EventEmitter throws on emit('error') when there is no 'error' listener.
    // A forwarded modem error must never crash the CLI, so drop it when nobody
    // is listening (the daemon retains the failure; this layer just relays).
    if (event === 'error' && this._emitter.listenerCount('error') === 0) return
    this._emitter.emit(event, data)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this._open = false
    this._emitter.removeAllListeners()
  }

  get isOpen(): boolean {
    return this._open
  }

  // ── Direct-mode only (not available in remote mode) ───────────────────────

  get rawAccess() {
    return undefined
  }

  get plugin() {
    return undefined
  }

  get preparation() {
    return undefined
  }
}

// ── RemoteBackend ───────────────────────────────────────────────────────────

export class RemoteBackend implements Backend {
  readonly mode = 'remote' as const
  private _client: DaemonClient | undefined
  private readonly _handles = new Map<string, RemoteDeviceHandle>()

  // ── Fleet management ──────────────────────────────────────────────────────

  async listDevices(): Promise<DiscoveredModem[]> {
    const client = await this._ensureClient()
    const ipcDevices = await client.listDevices()
    return ipcDevices.filter((d) => d.discovery !== undefined).map((d) => toDiscoveredModem(d))
  }

  async provision(target: DiscoveredModem): Promise<ProvisionResult> {
    const client = await this._ensureClient()
    // Use the deviceId the daemon assigned (carried on the DiscoveredModem),
    // not a locally re-derived one — re-deriving risks diverging from core's
    // identity function and missing the daemon's device index.
    const partial = await validated(client.provision(target.deviceId), provisionResultPartialSchema)
    // Reconstruct ProvisionResult with a minimal DeviceProfile.
    // The full profile (with AT config function fields) is not available over IPC --
    // the daemon holds the real profile internally. CLI commands never use it.
    return {
      transport: partial.transport,
      driver: partial.driver,
      profile: { name: partial.profile.name, vendorId: partial.profile.vendorId },
      model: partial.model,
    }
  }

  createWatcher(_options?: DeviceObserverOptions): DeviceWatcher {
    // Not yet implemented for daemon mode: bridging the daemon's serialized
    // lifecycle broadcasts back into the rich DeviceObserverEvents vocabulary
    // (session + analysis objects) is non-trivial and pending. Fail loud rather
    // than return a watcher that silently never emits.
    throw new NotSupportedError(
      'Live watch is not available via the daemon yet. Stop the daemon to use direct mode ' +
        '(sudo cellary daemon stop), or watch the daemon logs instead.',
    )
  }

  // ── Device connection ─────────────────────────────────────────────────────

  async connect(_options?: ConnectOptions): Promise<DeviceHandle> {
    const client = await this._ensureClient()

    // Wait for a ready device from the daemon
    const deviceId = await client.waitForReady()

    // Fetch device info to get model name
    const devices = await client.listDevices()
    const deviceInfo = devices.find((d) => d.deviceId === deviceId)
    const modelName = deviceInfo?.modelName

    const handle = new RemoteDeviceHandle(
      (method, params, timeoutMs) => client.serviceCall(method, deviceId, params, timeoutMs),
      (type) => client.openStream(deviceId, type),
      {
        modelName,
        protocols: deviceInfo?.protocols,
        httpUrl: deviceInfo?.httpUrl,
        serviceRouting: deviceInfo?.serviceRouting,
      },
    )
    this._handles.set(deviceId, handle)

    // Subscribe to modem events for this device
    const modemEvents = [
      'sms:received',
      'call:state',
      'network:registration',
      'sim:state',
      'stk:menu',
      'stk:text',
      'stk:input',
      'stk:inkey',
      'stk:notification',
      'stk:session:end',
      'stk:error',
      'error',
      'close',
      'disconnect',
      'reconnect',
    ]
    await client.subscribe(deviceId, modemEvents)

    // Wire daemon event notifications to handle
    client.on('event', (notification) => {
      if (notification.deviceId === deviceId) {
        handle._handleEvent(notification.event, notification.data)
      }
    })

    return handle
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    for (const handle of this._handles.values()) {
      await handle.close()
    }
    this._handles.clear()

    if (this._client !== undefined) {
      this._client.disconnect()
      this._client = undefined
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _ensureClient(): Promise<DaemonClient> {
    if (this._client !== undefined) return this._client

    const client = new DaemonClient()
    await client.connect()
    this._client = client
    return client
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reconstruct a DiscoveredModem from IPC discovery info.
 *
 * The `entry` field is always undefined in remote mode -- the USB database
 * entry contains functions and is not serializable. Commands that use
 * `findProductConfig(d.entry, d.productId)` gracefully handle undefined.
 */
function toDiscoveredModem(ipc: IpcDeviceInfo): DiscoveredModem {
  const d = ipc.discovery
  if (d === undefined) {
    throw new Error(`Device ${ipc.deviceId} has no discovery info`)
  }

  const base = {
    vendorId: ipc.vendorId,
    productId: d.productId,
    deviceId: ipc.deviceId,
    name: ipc.name,
    entry: undefined,
  }

  switch (d.mode) {
    case 'serial':
      return { ...base, mode: 'serial', path: d.path ?? '' }
    case 'http':
      return {
        ...base,
        mode: 'http',
        url: d.url ?? '',
        busNumber: d.busNumber ?? 0,
        portNumbers: d.portNumbers ?? [],
      }
    default:
      return {
        ...base,
        mode: d.mode,
        busNumber: d.busNumber ?? 0,
        portNumbers: d.portNumbers ?? [],
      }
  }
}
