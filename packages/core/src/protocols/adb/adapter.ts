/**
 * ADB protocol adapter.
 *
 * Provides OS-level access to modem devices running Linux via ADB shell.
 * Exposes:
 *   - System service: shell access, TTL manipulation, IMEI read/write, unlock
 *   - Optional AT bridge: vendor-injectable for AT commands over internal COM ports
 *   - Optional Device service: vendor-injectable for IMEI, temperature, firmware info
 *
 * The adapter itself is generic. Vendor-specific capabilities are injected
 * via constructor options (see AdbAdapterOptions).
 */

import { NotSupportedError } from '../../errors.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import type {
  Device,
  ProtocolAdapter,
  ServiceCapability,
  ServiceName,
  System,
  Thermal,
} from '../../protocols/adapter.js'
import type { InteractiveStream } from '../../protocols/services/system.js'
import type { AdbShell } from './shell.js'
import type { AdbAtBridge } from './types.js'

const MIN_TTL = 1
const MAX_TTL = 255
const AUTORUN_PATH = '/system/etc/autorun.sh'

// ── Vendor-injectable interfaces ──────────────────────────────────────────

/**
 * Vendor-specific IMEI operations injected into AdbSystem.
 * Implemented by vendor plugins that support NV-based IMEI access.
 */
export interface ImeiProvider {
  writeImei(imei: string): Promise<void>
  imei(): Promise<string>
}

/**
 * Vendor-specific device unlock for protected operations.
 * Implemented by vendor plugins that gate NV writes behind an auth step.
 */
export interface DeviceUnlocker {
  unlock(code: string): Promise<void>
  readonly isUnlocked: boolean
}

// ── AdbSystem ───────────────────────────────────────────────────────────────

class AdbSystem implements System {
  private readonly _shell: AdbShell
  private readonly _log: Logger
  private readonly _atBridge: AdbAtBridge | undefined
  private readonly _imeiProvider: ImeiProvider | undefined
  private readonly _unlocker: DeviceUnlocker | undefined

  constructor(
    shell: AdbShell,
    logger: Logger,
    options?: {
      atBridge?: AdbAtBridge | undefined
      imeiProvider?: ImeiProvider | undefined
      unlocker?: DeviceUnlocker | undefined
    },
  ) {
    this._shell = shell
    this._log = logger
    this._atBridge = options?.atBridge
    this._imeiProvider = options?.imeiProvider
    this._unlocker = options?.unlocker
  }

  async shell(command: string): Promise<string> {
    const result = await this._shell.exec(command)
    return result.stdout
  }

  async setTtl(ttl: number): Promise<void> {
    if (!Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) {
      throw new Error(
        `Invalid TTL value: ${ttl}. Must be an integer between ${MIN_TTL} and ${MAX_TTL}.`,
      )
    }

    this._log.info('Setting TTL', { ttl })

    // Flush existing TTL mangle rules to avoid duplicates
    await this._shell.exec('iptables -t mangle -F POSTROUTING')

    // Apply new TTL rule on wan0 (LTE uplink)
    const result = await this._shell.execWithStatus(
      `iptables -t mangle -A POSTROUTING -o wan0 -j TTL --ttl-set ${ttl}`,
    )

    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new Error(`Failed to set TTL: ${result.stdout}`)
    }

    // Verify the rule was applied
    const verify = await this._shell.exec('iptables -t mangle -L POSTROUTING -n')
    if (!verify.stdout.includes(`TTL set to ${ttl}`)) {
      throw new Error(`TTL rule verification failed. Expected "TTL set to ${ttl}" in output.`)
    }

    this._log.info('TTL set successfully', { ttl })
  }

  async getTtl(): Promise<number | undefined> {
    const result = await this._shell.exec('iptables -t mangle -L POSTROUTING -n')
    const [, ttlStr] = /TTL set to (\d+)/.exec(result.stdout) ?? []
    if (ttlStr === undefined) return undefined
    return Number(ttlStr)
  }

  async persistTtl(): Promise<void> {
    const currentTtl = await this.getTtl()
    if (currentTtl === undefined) {
      throw new Error('No TTL rule is currently active. Call setTtl() first.')
    }

    this._log.info('Persisting TTL rule', { ttl: currentTtl })

    // Remount /system as read-write (it's jffs2 read-only by default)
    const remount = await this._shell.execWithStatus('mount -o remount,rw /system')
    if (remount.exitCode !== undefined && remount.exitCode !== 0) {
      throw new Error(`Failed to remount /system as rw: ${remount.stdout}`)
    }

    const ttlCommand = `iptables -t mangle -A POSTROUTING -o wan0 -j TTL --ttl-set ${currentTtl}`

    // Check if the rule is already in autorun.sh
    const check = await this._shell.exec(`grep -c "ttl-set ${currentTtl}" ${AUTORUN_PATH}`)
    const count = Number(check.stdout.trim())
    if (!Number.isNaN(count) && count > 0) {
      this._log.info('TTL rule already in autorun.sh')
      // Remount back to read-only
      await this._shell.exec('mount -o remount,ro /system')
      return
    }

    // Append the iptables command to autorun.sh
    const append = await this._shell.execWithStatus(`echo '${ttlCommand}' >> ${AUTORUN_PATH}`)
    if (append.exitCode !== undefined && append.exitCode !== 0) {
      await this._shell.exec('mount -o remount,ro /system')
      throw new Error(`Failed to write to ${AUTORUN_PATH}: ${append.stdout}`)
    }

    // Remount back to read-only
    await this._shell.exec('mount -o remount,ro /system')

    this._log.info('TTL rule persisted to autorun.sh', { ttl: currentTtl })
  }

  async writeImei(imei: string): Promise<void> {
    if (this._imeiProvider === undefined) {
      throw new NotSupportedError('IMEI write not available on this device', ['adb'])
    }
    return this._imeiProvider.writeImei(imei)
  }

  async readImei(): Promise<string> {
    if (this._imeiProvider === undefined) {
      throw new NotSupportedError('IMEI read not available on this device', ['adb'])
    }
    return this._imeiProvider.imei()
  }

  async unlock(code: string): Promise<void> {
    if (this._unlocker === undefined) {
      throw new NotSupportedError('Device unlock not available on this device', ['adb'])
    }
    return this._unlocker.unlock(code)
  }

  async executeAt(command: string, waitMs?: number): Promise<string> {
    if (this._atBridge === undefined) {
      throw new NotSupportedError('No AT bridge available on this device', ['adb'])
    }
    this._log.debug('AT via bridge', { command, waitMs })
    return this._atBridge.execute(command, waitMs)
  }

  async openInteractiveShell(): Promise<InteractiveStream> {
    return this._shell.connection.openStream('shell:', 10_000)
  }
}

// ── AdbAdapter options ──────────────────────────────────────────────────────

export interface AdbAdapterOptions {
  /** Vendor-specific AT bridge for executing AT commands via internal COM port. */
  readonly atBridge?: AdbAtBridge | undefined
  /** Vendor-specific Device service (IMEI, temperature, firmware info). */
  readonly device?: Device | undefined
  /** Service capability metadata for the device service. */
  readonly deviceCapability?: ServiceCapability | undefined
  /** Vendor-specific Thermal service (sensors, CPU frequency cap). */
  readonly thermal?: Thermal | undefined
  /** Service capability metadata for the thermal service. */
  readonly thermalCapability?: ServiceCapability | undefined
  /** Vendor-specific IMEI provider for read/write operations. */
  readonly imeiProvider?: ImeiProvider | undefined
  /** Vendor-specific device unlocker for protected NV operations. */
  readonly unlocker?: DeviceUnlocker | undefined
}

// ── AdbAdapter ──────────────────────────────────────────────────────────────

export class AdbAdapter implements ProtocolAdapter {
  readonly kind = 'adb' as const
  readonly system: System
  readonly device: Device | undefined
  readonly thermal: Thermal | undefined

  private readonly _shell: AdbShell
  private readonly _log: Logger
  private readonly _deviceCapability: ServiceCapability | undefined
  private readonly _thermalCapability: ServiceCapability | undefined

  constructor(shell: AdbShell, logger?: Logger, options?: AdbAdapterOptions) {
    this._shell = shell
    this._log = logger ?? noopLogger
    this._deviceCapability = options?.deviceCapability
    this._thermalCapability = options?.thermalCapability

    this.system = new AdbSystem(shell, this._log.child({ service: 'system' }), {
      atBridge: options?.atBridge,
      imeiProvider: options?.imeiProvider,
      unlocker: options?.unlocker,
    })
    this.device = options?.device
    this.thermal = options?.thermal
  }

  async init(): Promise<void> {
    this._log.info('Initializing ADB adapter')
    const alive = await this._shell.ping()
    if (!alive) {
      throw new Error('ADB connection is not responding')
    }
    this._log.info('ADB adapter ready')
  }

  async close(): Promise<void> {
    await this._shell.close()
  }

  serviceCapabilities(): Partial<Record<ServiceName, ServiceCapability>> {
    const caps: Partial<Record<ServiceName, ServiceCapability>> = {
      system: { priority: 10, reason: 'OS-level access via ADB shell' },
    }

    if (this._deviceCapability !== undefined) {
      caps.device = this._deviceCapability
    }

    if (this._thermalCapability !== undefined) {
      caps.thermal = this._thermalCapability
    }

    return caps
  }
}
