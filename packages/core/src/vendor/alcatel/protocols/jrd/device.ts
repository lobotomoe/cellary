import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Device } from '../../../../protocols/adapter.js'
import type { DeviceInfo } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { systemInfoSchema } from './schemas.js'

/**
 * Device service for Alcatel JRD HTTP API.
 *
 * Uses GetSystemInfo (whitelist, no auth required).
 * Provides IMEI, firmware version, hardware version, device name.
 */
export class JrdDevice implements Device {
  private readonly _log: Logger

  constructor(
    private readonly client: JrdClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async info(): Promise<DeviceInfo> {
    this._log.debug('JRD call', { method: 'GetSystemInfo' })
    const data = await this.client.call('GetSystemInfo')
    const info = systemInfoSchema.parse(data)

    return {
      manufacturer: 'Alcatel',
      model: info.DeviceName,
      revision: info.SwVersion,
      imei: info.IMEI,
      hardwareVersion: info.HwVersion,
    }
  }

  async imei(): Promise<string> {
    this._log.debug('JRD call', { method: 'GetSystemInfo' })
    const data = await this.client.call('GetSystemInfo')
    const info = systemInfoSchema.parse(data)
    return info.IMEI
  }
}
