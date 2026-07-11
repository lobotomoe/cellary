/**
 * MiFi SMS service — send, list, delete via funcNo 1002/1003/1004.
 *
 * SMS response shapes are NOT yet confirmed via live testing.
 * list() will throw with raw API data until we establish the actual schema.
 * This is intentional — we want to discover the shape, not guess it.
 */
import type { Sms } from '../../../../protocols/adapter.js'
import type { SmsMessage } from '../../../../types.js'
import { FUNC } from './api-types.js'
import type { MifiClient } from './client.js'
import { MifiApiError } from './client.js'

export class MifiSms implements Sms {
  constructor(private readonly client: MifiClient) {}

  async send(to: string, text: string): Promise<number> {
    await this.client.callRaw(FUNC.smsSend, { number: to, text })
    return 0 // MiFi API doesn't return a message reference number
  }

  async list(): Promise<SmsMessage[]> {
    const envelope = await this.client.callRaw(FUNC.smsList)

    // We don't know the SMS list response shape yet.
    // Throw with the raw data so the caller (or developer) can see
    // what the API actually returns and build a proper schema.
    throw new MifiApiError(
      FUNC.smsList,
      `SMS list shape not yet implemented. Raw response: ${JSON.stringify(envelope.results[0])}`,
    )
  }

  async read(index: number): Promise<SmsMessage> {
    // Depends on list() — will throw until list shape is implemented
    const messages = await this.list()
    const msg = messages.find((m) => m.index === index)
    if (msg === undefined) {
      throw new Error(`SMS at index ${index} not found`)
    }
    return msg
  }

  async delete(index: number): Promise<void> {
    await this.client.callRaw(FUNC.smsDelete, { index })
  }
}
