/**
 * Device manager: wraps ModemPool and provides IPC-friendly access.
 *
 * Translates ModemPool events into IPC notifications and maintains
 * a mapping from deviceId to live Modem instances for service calls.
 */

import type {
  DeviceReadiness,
  DiscoveredModem,
  Logger,
  Modem,
  ModemEventMap,
  PooledDevice,
  PoolOptions,
  ProvisionResult,
} from 'cellary'
// eslint-disable-next-line @typescript-eslint/no-duplicate-imports -- type vs value imports
import { ModemPool, noopLogger, provision } from 'cellary'

import type { IpcDeviceInfo, IpcDiscoveryInfo, IpcReadinessStage } from './ipc/protocol.js'

/**
 * Type-safe stage mapping. Compile error if DeviceReadiness gains a stage
 * that IpcReadinessStage doesn't include.
 */
const STAGE_MAP: Record<DeviceReadiness['stage'], IpcReadinessStage> = {
  detected: 'detected',
  assessing: 'assessing',
  preparing: 'preparing',
  connecting: 'connecting',
  checking: 'checking',
  ready: 'ready',
  degraded: 'degraded',
  error: 'error',
  offline: 'offline',
}

// ── Types ──────────────────────────────────────────────────────────────────

export type DeviceEventHandler = (deviceId: string, event: string, data: unknown) => void

export interface DeviceManagerOptions extends PoolOptions {
  readonly onDeviceEvent?: DeviceEventHandler | undefined
}

// ── Device Manager ─────────────────────────────────────────────────────────

export class DeviceManager {
  private readonly _pool: ModemPool
  private readonly _onDeviceEvent: DeviceEventHandler | undefined
  private readonly _log: Logger

  /** deviceId -> live Modem instance (only when ready/degraded). */
  private readonly _modems = new Map<string, Modem>()

  constructor(options: DeviceManagerOptions) {
    this._onDeviceEvent = options.onDeviceEvent
    this._log = options.logger ?? noopLogger
    this._pool = new ModemPool(options)

    this._pool.on('device:added', (device) => {
      this._log.info('Device added', { deviceId: deviceIdFrom(device) })
      this._onDeviceEvent?.(deviceIdFrom(device), 'device:added', toIpcDevice(device))
    })

    this._pool.on('device:readiness', (device, _previous) => {
      const id = deviceIdFrom(device)

      // Track modem instances for service calls
      if (device.readiness.stage === 'ready' || device.readiness.stage === 'degraded') {
        this._modems.set(id, device.readiness.modem)
        this._wireModemEvents(id, device.readiness.modem)
      } else {
        this._modems.delete(id)
      }

      this._onDeviceEvent?.(id, 'device:readiness', toIpcDevice(device))
    })

    this._pool.on('device:removed', (device) => {
      const id = deviceIdFrom(device)
      this._modems.delete(id)
      this._onDeviceEvent?.(id, 'device:removed', toIpcDevice(device))
    })
  }

  async start(): Promise<void> {
    await this._pool.start()
  }

  async stop(): Promise<void> {
    await this._pool.stop()
    this._modems.clear()
  }

  /** List all tracked devices with IPC-safe info. */
  listDevices(): IpcDeviceInfo[] {
    return this._pool.devices.map((device) => toIpcDevice(device))
  }

  /**
   * Wait for a device to reach 'ready' stage. Returns its deviceId.
   *
   * With a deviceId, waits for that specific device (used by `--port`
   * targeting); otherwise resolves on the first device to become ready.
   */
  async waitForReady(timeoutMs?: number, deviceId?: string): Promise<string> {
    if (deviceId !== undefined) {
      await this._pool.waitForDeviceId(deviceId, timeoutMs)
      return deviceId
    }
    const modem = await this._pool.waitForReady(timeoutMs)
    // Reverse-lookup: find the deviceId for this modem instance
    for (const [id, m] of this._modems) {
      if (m === modem) return id
    }
    throw new Error('Modem became ready but was not tracked')
  }

  /** Get the live Modem for a deviceId. Throws if not ready. */
  getModem(deviceId: string): Modem {
    const modem = this._modems.get(deviceId)
    if (!modem) {
      throw new DeviceNotReadyError(deviceId)
    }
    return modem
  }

  /**
   * Provision a device by its deviceId.
   *
   * Looks up the DiscoveredModem from the current USB cycle and runs
   * the mode-switch provisioning (storage -> modem).
   */
  async provision(deviceId: string): Promise<ProvisionResult> {
    const device = this._findDevice(deviceId)
    const discovered = device.session.currentCycle?.modem
    if (discovered === undefined) {
      throw new Error(`Device ${deviceId} has no active USB cycle`)
    }
    this._log.info('Provisioning device', { deviceId, mode: discovered.mode })
    return provision(discovered)
  }

  /**
   * Hardware-reset a device's USB transport to recover from a stuck state.
   *
   * Calls modem.resetTransport() which performs a USB bus reset, then
   * removes the modem from tracking. The device will re-enumerate on
   * the USB bus and be re-discovered by the pool automatically.
   */
  async resetDevice(deviceId: string): Promise<void> {
    const modem = this._modems.get(deviceId)
    if (!modem) {
      throw new DeviceNotReadyError(deviceId)
    }

    this._log.info('Resetting device transport', { deviceId })
    await modem.resetTransport()
    this._modems.delete(deviceId)

    // Re-trigger the pool's readiness pipeline so the device reconnects.
    // USB reset on macOS doesn't cause a detach/reattach event, so the pool
    // would otherwise leave the device in 'offline' state indefinitely.
    this._pool.restartDevice(deviceId)
  }

  get deviceCount(): number {
    return this._pool.devices.length
  }

  private _findDevice(deviceId: string): PooledDevice {
    for (const device of this._pool.devices) {
      if (device.session.deviceId === deviceId) return device
    }
    throw new Error(`Device ${deviceId} not found`)
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Forward modem events to the device event handler. */
  private _wireModemEvents(deviceId: string, modem: Modem): void {
    const forward = <K extends keyof ModemEventMap>(event: K) => {
      modem.on(event, (...args: ModemEventMap[K]) => {
        this._onDeviceEvent?.(deviceId, event, args[0])
      })
    }

    forward('call:state')
    forward('sms:received')
    forward('network:registration')
    forward('sim:state')
    forward('error')
    forward('close')
    forward('disconnect')
    forward('reconnect')
    forward('reconnect:failed')

    // STK events — forwarded from the modem's stk EventEmitter
    const stkEvents = [
      'menu',
      'text',
      'input',
      'inkey',
      'notification',
      'session:end',
      'error',
    ] as const
    for (const stkEvent of stkEvents) {
      modem.stk.on(stkEvent, (data: unknown) => {
        this._onDeviceEvent?.(deviceId, `stk:${stkEvent}`, data)
      })
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function deviceIdFrom(device: PooledDevice): string {
  return device.session.deviceId
}

function toIpcDevice(device: PooledDevice): IpcDeviceInfo {
  return toIpcDeviceWithId(deviceIdFrom(device), device)
}

function toIpcDiscovery(modem: DiscoveredModem): IpcDiscoveryInfo {
  if (modem.mode === 'serial') {
    return { mode: 'serial', productId: modem.productId, path: modem.path }
  }
  const base = {
    productId: modem.productId,
    busNumber: modem.busNumber,
    portNumbers: [...modem.portNumbers],
  }
  if (modem.mode === 'http') {
    return { mode: 'http', ...base, url: modem.url }
  }
  return { mode: modem.mode, ...base }
}

function toIpcDeviceWithId(deviceId: string, device: PooledDevice): IpcDeviceInfo {
  const discovery = device.session.currentCycle?.modem
  const readiness = device.readiness

  const base: IpcDeviceInfo = {
    deviceId,
    vendorId: device.vendorId,
    name: device.name,
    stage: STAGE_MAP[readiness.stage],
    firstSeenAt: device.firstSeenAt,
    discovery: discovery !== undefined ? toIpcDiscovery(discovery) : undefined,
    modelName:
      readiness.stage === 'ready' || readiness.stage === 'degraded'
        ? readiness.modem.model?.name
        : undefined,
    protocols:
      readiness.stage === 'ready' || readiness.stage === 'degraded'
        ? readiness.modem.protocols
        : undefined,
    httpUrl:
      readiness.stage === 'ready' || readiness.stage === 'degraded'
        ? readiness.modem.httpUrl
        : undefined,
    serviceRouting:
      readiness.stage === 'ready' || readiness.stage === 'degraded'
        ? readiness.modem.serviceRouting
        : undefined,
  }

  if (readiness.stage === 'error') {
    return {
      ...base,
      error: readiness.error.message,
      recoverable: readiness.recoverable,
    }
  }

  return base
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class DeviceNotReadyError extends Error {
  override readonly name = 'DeviceNotReadyError'

  constructor(deviceId: string) {
    super(`Device ${deviceId} is not ready`)
  }
}
