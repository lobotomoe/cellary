/**
 * MiFi HTTP API client over RNDIS transport.
 *
 * Wraps the low-level httpPost/httpGet from transport/rndis/http.ts
 * into a funcNo-oriented API. Handles response envelope validation,
 * error checking, and payload parsing via Zod schemas.
 */
import type { z } from 'zod'

import { type AuditSink, noopAuditSink } from '../../../../audit.js'
import { CellaryError } from '../../../../errors.js'
import { httpPost } from '../../../../transport/rndis/http.js'
import { RndisTransport, type RndisTransportOptions } from '../../../../transport/rndis/index.js'
import type { MifiRawEnvelope } from './api-types.js'
import { mifiEnvelopeSchema, mifiRawEnvelopeSchema } from './api-types.js'
import { maskMifiSecrets } from './mask.js'

export class MifiApiError extends CellaryError {
  override name = 'MifiApiError'

  readonly funcNo: number
  readonly errorInfo: string

  constructor(funcNo: number, errorInfo: string, options?: { cause?: unknown }) {
    super(`MiFi API error on funcNo=${funcNo}`, { details: errorInfo, cause: options?.cause })
    this.funcNo = funcNo
    this.errorInfo = errorInfo
  }
}

export class MifiClient {
  private readonly _transportOptions: RndisTransportOptions
  private readonly _host: string | undefined
  private readonly _audit: AuditSink
  private _transport: RndisTransport

  constructor(options: RndisTransportOptions, host?: string | undefined, auditSink?: AuditSink) {
    this._transportOptions = options
    this._host = host
    this._audit = auditSink ?? noopAuditSink
    this._transport = new RndisTransport(options)
  }

  get gatewayIp(): string {
    return this._host ?? this._transport.gatewayIp
  }

  get isOpen(): boolean {
    return this._transport.isOpen
  }

  /** The underlying RNDIS transport (for USB event listening). */
  get transport(): RndisTransport {
    return this._transport
  }

  async open(): Promise<void> {
    await this._transport.open()
  }

  async close(): Promise<void> {
    await this._transport.close()
  }

  /**
   * Destroy the current transport and create a fresh one.
   *
   * Used after USB disconnect (thermal reboot, cable pull). Creates a
   * brand new lwIP stack to avoid stale state from the previous session.
   */
  async reopen(): Promise<void> {
    try {
      await this._transport.close()
    } catch {
      /* may already be dead */
    }
    this._transport = new RndisTransport(this._transportOptions)
    await this._transport.open()
  }

  /**
   * Call a funcNo endpoint and validate the response payload with a Zod schema.
   *
   * Builds the request body, sends via RNDIS HTTP, validates the response
   * envelope, checks for API errors, and returns the validated payload.
   */
  async call<T>(
    funcNo: number,
    schema: z.ZodType<T>,
    params?: Record<string, unknown> | undefined,
  ): Promise<T> {
    const envelope = await this._post(funcNo, params)
    const envelopeSchema = mifiEnvelopeSchema(schema)
    const parsed = envelopeSchema.safeParse(envelope)

    if (!parsed.success) {
      throw new MifiApiError(funcNo, `Invalid response shape: ${parsed.error.message}`)
    }

    this._checkEnvelopeErrors(funcNo, parsed.data.flag, parsed.data.error_info)
    return parsed.data.results[0]
  }

  /**
   * Call a funcNo endpoint without payload schema validation.
   *
   * Use for endpoints whose response shapes are unknown or vary.
   * The envelope structure is still validated.
   */
  async callRaw(
    funcNo: number,
    params?: Record<string, unknown> | undefined,
  ): Promise<MifiRawEnvelope> {
    const envelope = await this._post(funcNo, params)
    const parsed = mifiRawEnvelopeSchema.safeParse(envelope)

    if (!parsed.success) {
      throw new MifiApiError(funcNo, `Invalid envelope: ${parsed.error.message}`)
    }

    this._checkEnvelopeErrors(funcNo, parsed.data.flag, parsed.data.error_info)
    return parsed.data
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async _post(
    funcNo: number,
    params?: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const body = JSON.stringify({ funcNo, ...params })
    this._audit.record({
      timestamp: Date.now(),
      protocol: 'mifi',
      direction: 'tx',
      text: `POST /ajax ${maskMifiSecrets(body)}`,
    })

    const response = await httpPost(this._transport, '/ajax', body, { host: this._host })
    this._audit.record({
      timestamp: Date.now(),
      protocol: 'mifi',
      direction: 'rx',
      text: maskMifiSecrets(response.body),
    })

    if (response.status !== 200) {
      throw new MifiApiError(funcNo, `HTTP ${response.status} ${response.statusText}`)
    }

    try {
      const parsed: unknown = JSON.parse(response.body)
      return parsed
    } catch (err: unknown) {
      const detail = `Invalid JSON: ${response.body.slice(0, 200)}`
      const wrapped = new MifiApiError(funcNo, detail, { cause: err })
      throw wrapped
    }
  }

  private _checkEnvelopeErrors(funcNo: number, flag: string, errorInfo: string): void {
    if (flag !== '1') {
      throw new MifiApiError(funcNo, `flag=${flag}, error_info=${errorInfo}`)
    }
    if (errorInfo !== 'none') {
      throw new MifiApiError(funcNo, errorInfo)
    }
  }
}
