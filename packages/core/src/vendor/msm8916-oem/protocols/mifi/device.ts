/**
 * MiFi Device service — device info and IMEI via funcNo=1029.
 */
import type { Device } from '../../../../protocols/adapter.js'
import type { DeviceInfo } from '../../../../types.js'
import { FUNC, mifiDeviceInfoSchema } from './api-types.js'
import type { MifiClient } from './client.js'

export class MifiDevice implements Device {
  constructor(private readonly client: MifiClient) {}

  async info(): Promise<DeviceInfo> {
    const data = await this.client.call(FUNC.deviceInfo, mifiDeviceInfoSchema)
    return {
      manufacturer: data.manufacture,
      model: '', // not provided by MiFi API
      revision: data.fwversion,
      imei: data.imei,
    }
  }

  async imei(): Promise<string> {
    const data = await this.client.call(FUNC.deviceInfo, mifiDeviceInfoSchema)
    return data.imei
  }
}
