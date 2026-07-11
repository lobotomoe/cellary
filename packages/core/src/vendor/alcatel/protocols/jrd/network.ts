import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Network } from '../../../../protocols/adapter.js'
import type { RegistrationInfo, SignalInfo } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { JRD_NETWORK_TYPE, networkInfoSchema } from './schemas.js'

const BER_UNKNOWN = 99

/**
 * Parse a JRD signal field (string like "-49", "-1", "FF") into a number.
 * Returns undefined for non-numeric values or "FF" (firmware unknown marker).
 */
function parseSignalField(value: string | undefined): number | undefined {
  if (value === undefined || value === 'FF') return undefined
  const num = Number(value)
  if (Number.isNaN(num)) return undefined
  return num
}

/**
 * Network service for Alcatel JRD HTTP API.
 *
 * Uses GetNetworkInfo (whitelist, no auth required).
 * Provides RSSI, RSRP, RSRQ, SINR, band, and registration status.
 *
 * Note: all values are zero/empty when SIM is locked (SIMState != 7).
 */
export class JrdNetwork implements Network {
  private readonly _log: Logger

  constructor(
    private readonly client: JrdClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async signal(): Promise<SignalInfo> {
    this._log.debug('JRD call', { method: 'GetNetworkInfo' })
    const data = await this.client.call('GetNetworkInfo')
    const info = networkInfoSchema.parse(data)

    const rawRssi = parseSignalField(info.RSSI)
    const rssi = rawRssi !== undefined && rawRssi < 0 ? rawRssi : undefined
    const rsrp = parseSignalField(info.RSRP)
    const rsrq = parseSignalField(info.RSRQ)
    const sinr = parseSignalField(info.SINR)
    const band = info.Band !== undefined && info.Band > 0 ? `B${info.Band}` : undefined
    const technology = info.NetworkType > 0 ? JRD_NETWORK_TYPE[info.NetworkType] : undefined

    return { rssi, bitErrorRate: BER_UNKNOWN, technology, rsrp, rsrq, sinr, band }
  }

  async registration(): Promise<RegistrationInfo> {
    this._log.debug('JRD call', { method: 'GetNetworkInfo' })
    const data = await this.client.call('GetNetworkInfo')
    const info = networkInfoSchema.parse(data)

    // NetworkType 0 = no service
    if (info.NetworkType === 0) {
      return { status: 'notRegistered' }
    }

    if (info.Roaming === 1) {
      return { status: 'roaming' }
    }

    return { status: 'home' }
  }

  async operator(): Promise<string | undefined> {
    this._log.debug('JRD call', { method: 'GetNetworkInfo' })
    const data = await this.client.call('GetNetworkInfo')
    const info = networkInfoSchema.parse(data)

    if (info.NetworkName === undefined || info.NetworkName === 'N/A') {
      return undefined
    }
    return info.NetworkName
  }
}
