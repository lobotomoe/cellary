import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { SmsCount } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { smsStorageSchema } from './schemas.js'

/**
 * SMS count-only service from JRD HTTP API.
 *
 * Uses GetSMSStorageState (whitelist, no auth required).
 * Full SMS operations (send/list/read/delete) require authenticated session.
 */
export class JrdSmsCounter {
  private readonly _log: Logger

  constructor(
    private readonly client: JrdClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async count(): Promise<SmsCount> {
    this._log.debug('JRD call', { method: 'GetSMSStorageState' })
    const data = await this.client.call('GetSMSStorageState')
    const info = smsStorageSchema.parse(data)

    return {
      inbox: info.SMSCount,
      capacity: info.SMSMaxCount,
      unread: info.UnreadSMSCount,
    }
  }
}
