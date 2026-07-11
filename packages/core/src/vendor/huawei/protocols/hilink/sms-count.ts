import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { SmsCount } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { smsCountSchema } from './schemas.js'
import { parseHiLinkXml } from './xml.js'

/**
 * SMS count-only service from HiLink HTTP API.
 *
 * Provides count() via GET /api/sms/sms-count (unauthenticated).
 * Full SMS operations (send/list/read/delete) are not supported via HiLink
 * on most devices -- those are handled by the AT adapter when available.
 */
export class HiLinkSmsCounter {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async count(): Promise<SmsCount> {
    this._log.debug('GET', { path: 'api/sms/sms-count' })
    const xml = await this.client.get('api/sms/sms-count')
    const data = parseHiLinkXml(xml, smsCountSchema)

    return {
      inbox: data.LocalInbox + data.SimInbox,
      capacity: data.LocalMax + data.SimMax,
      unread: data.LocalUnread + data.SimUnread,
    }
  }
}
