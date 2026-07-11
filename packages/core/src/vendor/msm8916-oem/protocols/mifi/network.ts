/**
 * MiFi Network service — signal, registration, operator via funcNo=1001.
 */
import type { Network } from '../../../../protocols/adapter.js'
import type { RegistrationInfo, SignalInfo } from '../../../../types.js'
import { FUNC, mifiNetworkStatusSchema } from './api-types.js'
import type { MifiClient } from './client.js'

/**
 * Map MiFi netmode strings to standard technology names.
 *
 * Known values from community research: "LTE", "WCDMA", "GSM", "UNKNOWN".
 * Passes through unrecognized values as-is for forward compatibility.
 */
function mapNetmode(netmode: string): string | undefined {
  if (netmode === 'UNKNOWN' || netmode === '') return undefined
  return netmode
}

export class MifiNetwork implements Network {
  constructor(private readonly client: MifiClient) {}

  async signal(): Promise<SignalInfo> {
    const data = await this.client.call(FUNC.networkStatus, mifiNetworkStatusSchema)
    return {
      // MiFi API returns 0 when signal is not detectable — honest undefined
      rssi: data.rssi === 0 ? undefined : data.rssi,
      bitErrorRate: 99, // not provided by MiFi API
      technology: mapNetmode(data.netmode),
    }
  }

  async registration(): Promise<RegistrationInfo> {
    const data = await this.client.call(FUNC.networkStatus, mifiNetworkStatusSchema)
    return {
      status: data.netstatus === 'Connected' ? 'home' : 'notRegistered',
      technology: mapNetmode(data.netmode),
    }
  }

  async operator(): Promise<string | undefined> {
    const data = await this.client.call(FUNC.networkStatus, mifiNetworkStatusSchema)
    return data.oper || undefined
  }
}
