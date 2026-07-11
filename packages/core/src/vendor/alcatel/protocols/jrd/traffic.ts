import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Traffic } from '../../../../protocols/adapter.js'
import type { TrafficStats } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { connectionStateSchema } from './schemas.js'

/**
 * Traffic service for Alcatel JRD HTTP API.
 *
 * Uses GetConnectionState (whitelist, no auth required).
 * Provides current session download/upload bytes, duration, and speeds.
 */
export class JrdTraffic implements Traffic {
  private readonly _log: Logger

  constructor(
    private readonly client: JrdClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async session(): Promise<TrafficStats> {
    this._log.debug('JRD call', { method: 'GetConnectionState' })
    const data = await this.client.call('GetConnectionState')
    const info = connectionStateSchema.parse(data)

    return {
      downloadBytes: info.DlBytes ?? 0,
      uploadBytes: info.UlBytes ?? 0,
      durationSeconds: info.ConnectionTime ?? 0,
      downloadRate: info.Speed_Dl,
      uploadRate: info.Speed_Ul,
    }
  }
}
