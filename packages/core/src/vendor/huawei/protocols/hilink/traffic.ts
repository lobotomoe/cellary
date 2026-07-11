import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Traffic } from '../../../../protocols/adapter.js'
import type { TrafficStats } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { monthStatisticsSchema, trafficStatisticsSchema } from './schemas.js'
import { parseHiLinkXml } from './xml.js'

/**
 * Traffic statistics from HiLink HTTP API.
 *
 * Both endpoints are unauthenticated — no credentials needed.
 * - session() → GET /api/monitoring/traffic-statistics
 * - monthly() → GET /api/monitoring/month_statistics
 */
export class HiLinkTraffic implements Traffic {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async session(): Promise<TrafficStats> {
    this._log.debug('GET', { path: 'api/monitoring/traffic-statistics' })
    const xml = await this.client.get('api/monitoring/traffic-statistics')
    const data = parseHiLinkXml(xml, trafficStatisticsSchema)

    return {
      downloadBytes: data.CurrentDownload,
      uploadBytes: data.CurrentUpload,
      durationSeconds: data.CurrentConnectTime,
      downloadRate: data.CurrentDownloadRate,
      uploadRate: data.CurrentUploadRate,
    }
  }

  async monthly(): Promise<TrafficStats> {
    this._log.debug('GET', { path: 'api/monitoring/month_statistics' })
    const xml = await this.client.get('api/monitoring/month_statistics')
    const data = parseHiLinkXml(xml, monthStatisticsSchema)

    return {
      downloadBytes: data.CurrentMonthDownload,
      uploadBytes: data.CurrentMonthUpload,
      durationSeconds: data.MonthDuration,
    }
  }
}
