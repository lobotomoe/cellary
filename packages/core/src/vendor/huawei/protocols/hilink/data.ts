import { z } from 'zod'
import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Data } from '../../../../protocols/adapter.js'
import type { DataConnectionStatus, PdpContext } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { parseHiLinkXml } from './xml.js'

// ConnectionStatus values from /api/monitoring/status (see README.md)
const CONN_STATUS_CONNECTED = 901

const dataStatusSchema = z.object({
  ConnectionStatus: z.number(),
})

/**
 * Cellular data connection status from HiLink HTTP API.
 *
 * Read-only: HiLink auto-manages PDP contexts and PS attach.
 * defineContext/activate/deactivate are not implemented because
 * the firmware handles data connection lifecycle automatically.
 *
 * Both methods use GET /api/monitoring/status (ConnectionStatus field).
 * APN, IP address, and PDP type are only available via auth-required
 * /api/dialup/profiles — not implemented yet.
 */
export class HiLinkData implements Data {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async status(): Promise<DataConnectionStatus> {
    const connected = await this.isConnected()
    // HiLink doesn't expose PS attach state separately.
    // If connected, PS is necessarily attached. If disconnected, we can't tell.
    return { state: connected ? 'connected' : 'disconnected', attached: connected }
  }

  async contexts(): Promise<PdpContext[]> {
    const connected = await this.isConnected()

    // HiLink auto-manages a single PDP context.
    // APN and IP only available via auth-required /api/dialup/profiles — not implemented.
    return [
      {
        cid: 1,
        pdpType: 'IP',
        apn: undefined,
        active: connected,
      },
    ]
  }

  private async isConnected(): Promise<boolean> {
    this._log.debug('GET', { path: 'api/monitoring/status' })
    const xml = await this.client.get('api/monitoring/status')
    const data = parseHiLinkXml(xml, dataStatusSchema)
    return data.ConnectionStatus === CONN_STATUS_CONNECTED
  }
}
