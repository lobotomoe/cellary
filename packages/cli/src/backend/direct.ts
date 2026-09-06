/**
 * Direct backend: wraps a core Modem for local USB/serial access.
 *
 * DirectDeviceHandle delegates all service calls directly to the Modem.
 * DirectBackend resolves which modem to open (explicit --port, the only
 * operable device, or an interactive choice) and records every exchange with
 * it to the durable device-comms audit, exactly as the daemon does.
 */

import type {
  AuditSink,
  AvailableNetwork,
  Capabilities,
  ConnectionProgress,
  Data,
  Device,
  DeviceObserverOptions,
  DiscoveredModem,
  Logger,
  ModelInfo,
  ModemEventMap,
  Network,
  PrepReport,
  ProtocolAdapter,
  ProvisionResult,
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
} from 'cellary'
import { DEFAULT_RESOLVERS, DeviceObserver, discover, Modem, provision } from 'cellary'

import { type DeviceAudit, openDeviceAudit } from '../lib/audit.js'
import { busLocation, deviceDisplayName, formatVidPid } from '../lib/device-format.js'
import { createLogger } from '../lib/logger.js'
import { promptModemSelection } from '../lib/prompts.js'

import type { Backend, ConnectOptions, DeviceHandle, DeviceWatcher, RawAccess } from './types.js'

// ── DirectDeviceHandle ─────────────────────────────────────────────────────

class DirectRawAccess implements RawAccess {
  private readonly _modem: Modem

  constructor(modem: Modem) {
    this._modem = modem
  }

  adapter(kind: string): ProtocolAdapter | undefined {
    return this._modem.adapter(kind)
  }
}

class DirectDeviceHandle implements DeviceHandle {
  private readonly _modem: Modem
  private readonly _audit: DeviceAudit
  readonly rawAccess: RawAccess
  readonly plugin: VendorPlugin | undefined

  constructor(modem: Modem, audit: DeviceAudit) {
    this._modem = modem
    this._audit = audit
    this.rawAccess = new DirectRawAccess(modem)
    this.plugin = modem.plugin
  }

  // ── Services ─────────────────────────────────────────────────────────────

  get network(): Network {
    return this._modem.network
  }
  get sms(): Sms {
    return this._modem.sms
  }
  get sim(): Sim {
    return this._modem.sim
  }
  get device(): Device {
    return this._modem.device
  }
  get voice(): Voice {
    return this._modem.voice
  }
  get ussd(): Ussd {
    return this._modem.ussd
  }
  get traffic(): Traffic {
    return this._modem.traffic
  }
  get data(): Data {
    return this._modem.data
  }
  get capabilities(): Capabilities {
    return this._modem.capabilities
  }
  get stk(): Stk {
    return this._modem.stk
  }
  get system(): System {
    return this._modem.system
  }
  get thermal(): Thermal {
    return this._modem.thermal
  }

  // ── Modem-level operations ───────────────────────────────────────────────

  async scanNetworks(): Promise<AvailableNetwork[]> {
    return this._modem.scanNetworks()
  }

  async selectNetwork(plmn: string): Promise<void> {
    return this._modem.selectNetwork(plmn)
  }

  async selectNetworkAutomatic(): Promise<void> {
    return this._modem.selectNetworkAutomatic()
  }

  // ── Metadata ─────────────────────────────────────────────────────────────

  get protocols(): readonly string[] {
    return this._modem.protocols
  }

  get httpUrl(): string | undefined {
    return this._modem.httpUrl
  }

  get model(): ModelInfo | undefined {
    return this._modem.model
  }

  get serviceRouting(): Readonly<Record<string, ServiceRouteInfo>> {
    return this._modem.serviceRouting
  }

  // ── Events ───────────────────────────────────────────────────────────────

  on<K extends keyof ModemEventMap>(event: K, listener: (...args: ModemEventMap[K]) => void): void {
    this._modem.on(event, listener)
  }

  off<K extends keyof ModemEventMap>(
    event: K,
    listener: (...args: ModemEventMap[K]) => void,
  ): void {
    this._modem.off(event, listener)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    try {
      await this._modem.close()
    } finally {
      // The audit outlives the modem by design: the close exchange is recorded.
      this._audit.close()
    }
  }

  get isOpen(): boolean {
    return this._modem.isOpen
  }

  // ── Direct-mode only ─────────────────────────────────────────────────────

  get preparation(): PrepReport | undefined {
    return this._modem.preparation
  }
}

// ── DirectBackend ──────────────────────────────────────────────────────────

/**
 * Progress callback for modem connection.
 * Only writes to stderr when there's something worth reporting (retries).
 * Stdout stays clean for command output.
 */
function onProgress(event: ConnectionProgress): void {
  if (event.attempt !== undefined && event.maxAttempts !== undefined) {
    process.stderr.write(`\r  ${event.message} (attempt ${event.attempt}/${event.maxAttempts})`)
  }
}

export class DirectBackend implements Backend {
  readonly mode = 'direct' as const

  // ── Fleet management ──────────────────────────────────────────────────────

  async listDevices(): Promise<DiscoveredModem[]> {
    return discover()
  }

  async provision(target: DiscoveredModem): Promise<ProvisionResult> {
    return provision(target)
  }

  createWatcher(options?: DeviceObserverOptions): DeviceWatcher {
    return new DeviceObserver({
      resolvers: DEFAULT_RESOLVERS,
      ...options,
    })
  }

  // ── Device connection ─────────────────────────────────────────────────────

  async connect(options?: ConnectOptions): Promise<DeviceHandle> {
    const verbose = options?.verbose ?? false
    const logger = createLogger(verbose)
    const autoInit = options?.autoInit
    const target = options?.target

    if (target !== undefined) {
      return openHandle(target, logger, (auditSink) =>
        Modem.open({ path: target, logger, onProgress, autoInit, auditSink }),
      )
    }

    const allModems = await discover()
    const operable = allModems.filter((m) => m.mode !== 'storage')

    if (operable.length === 0) {
      if (allModems.length > 0) {
        const lines = ['All devices are in storage mode (not ready):']
        for (const m of allModems) {
          lines.push(`  ${formatModem(m)}`)
        }
        lines.push('Run: sudo cellary init (or sudo cellary init --all)')
        throw new Error(lines.join('\n'))
      }
      throw new Error('No modem found. Connect a modem or specify --port.')
    }

    if (operable.length === 1) {
      const only = operable[0]
      if (only === undefined) throw new Error('Unexpected empty modems array')
      return openDiscovered(only, logger, autoInit)
    }

    const selected = await promptModemSelection(operable)
    return openDiscovered(selected, logger, autoInit)
  }

  async dispose(): Promise<void> {
    // DirectBackend holds no long-lived resources
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Open the audit for a device, then the modem through it, so the very first
 * init command is already recorded. If opening the modem fails, the audit is
 * closed again -- the handle that would have owned it never exists.
 */
async function openHandle(
  deviceId: string,
  logger: Logger,
  open: (auditSink: AuditSink) => Promise<Modem>,
): Promise<DeviceHandle> {
  const audit = openDeviceAudit(deviceId, logger)
  let modem: Modem
  try {
    modem = await open(audit.sink)
  } catch (err) {
    audit.close()
    throw err
  }
  return new DirectDeviceHandle(modem, audit)
}

function openDiscovered(
  modem: DiscoveredModem,
  logger: Logger,
  autoInit?: boolean | undefined,
): Promise<DeviceHandle> {
  return openHandle(modem.deviceId, logger, (auditSink) => {
    if (modem.mode === 'serial') {
      return Modem.open({ path: modem.path, logger, onProgress, autoInit, auditSink })
    }
    return Modem.detect(modem, { logger, onProgress, autoInit, auditSink })
  })
}

function formatModem(m: DiscoveredModem): string {
  const name = deviceDisplayName(m)
  const ids = formatVidPid(m.vendorId, m.productId)
  const bus = busLocation(m)
  switch (m.mode) {
    case 'serial':
      return `${name}  ${m.path}  ${ids}`
    case 'modem-usb':
      return `${name}  ${ids}  ${bus}  (USB direct)`
    case 'http':
      return `${name}  ${ids}  ${bus}  (${m.url})`
    case 'storage':
      return `${name}  ${ids}  ${bus}  (needs mode switch)`
    case 'emergency':
      return `${name}  ${ids}  ${bus}  (BootROM)`
    case 'download':
      return `${name}  ${ids}  ${bus}  (download mode)`
  }
}
