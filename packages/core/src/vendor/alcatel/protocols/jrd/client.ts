import * as net from 'node:net'
import { z } from 'zod'

import { type HttpResponse, httpPost, parseHttpResponse } from '../../../../transport/http.js'
import type { UsbNetTransport } from '../../../../transport/usb-net.js'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Alcatel/TCL verification key for whitelist API calls.
 * Hardcoded in the device firmware (sdk.js). Required for all requests.
 */
const VERIFICATION_KEY = 'KSDHSDFOGQ5WERYTUIQWERTYUISDFG1HJZXCVCXBN2GDSMNDHKVKFsVBNf'

// ── JSON-RPC envelope schemas ───────────────────────────────────────────────

const jrdErrorSchema = z.object({
  error: z.object({
    code: z.coerce.number(),
    message: z.string(),
  }),
})

const jrdSuccessSchema = z.object({
  result: z.unknown(),
})

// ── Shared interface ────────────────────────────────────────────────────────

/** Common interface for JRD API clients (OS HTTP and userspace USB). */
export interface JrdClient {
  call(method: string, params?: unknown): Promise<unknown>
  destroy(): void
}

// ── OS HTTP client ──────────────────────────────────────────────────────────

/**
 * JRD client over the OS network stack, using a raw TCP socket.
 *
 * Requires the OS to provide IP connectivity to the device (e.g. macOS
 * AppleUserECM brings up the CDC-ECM interface; the host must hold an IP on the
 * gateway subnet). Preferred over the userspace ECM bridge when available.
 *
 * Quirks handled (Alcatel MW45V, hardware-verified):
 * - Server emits bare-LF HTTP responses (no CRLF). Node's http parser and undici
 *   both reject these, so we read the raw socket and parse with cellary's own
 *   lenient parser (shared with the USB path).
 * - Whitelist auth requires a same-origin Referer header (else -32697).
 * - No reliable keep-alive: one short-lived socket per request (Connection: close).
 * - Endpoint format: POST /jrd/webapi?api=<MethodName>
 */
export class JrdHttpClient implements JrdClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async call(method: string, params: unknown = null): Promise<unknown> {
    const body = buildJrdBody(method, params)
    const response = await this.request(method, body)
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`JRD HTTP ${response.status} from ${method}`)
    }
    return parseJrdResponse(method, response.body)
  }

  private request(method: string, body: string): Promise<HttpResponse> {
    const url = new URL(`/jrd/webapi?api=${method}`, this.baseUrl)
    const host = url.hostname
    const port = url.port === '' ? 80 : Number(url.port)
    const referer = new URL('/', this.baseUrl).href

    const payload = [
      `POST ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${host}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      `Referer: ${referer}`,
      `_TclRequestVerificationKey: ${VERIFICATION_KEY}`,
      '',
      body,
    ].join('\r\n')

    return new Promise<HttpResponse>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const socket = net.connect({ host, port })

      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        action()
      }

      timer = setTimeout(() => {
        finish(() =>
          reject(new Error(`JRD request to ${method} timed out after ${this.timeoutMs}ms`)),
        )
      }, this.timeoutMs)

      socket.on('connect', () => socket.write(payload))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('end', () => finish(() => resolve(parseHttpResponse(Buffer.concat(chunks)))))
      socket.on('error', (err: Error) => {
        // With Connection: close the device may RST right after sending the body.
        // If the full response already arrived, honor it; otherwise surface the error.
        if (chunks.length > 0) {
          finish(() => resolve(parseHttpResponse(Buffer.concat(chunks))))
        } else {
          finish(() => reject(new Error(`JRD request to ${method} failed`, { cause: err })))
        }
      })
    })
  }

  destroy(): void {
    // No persistent resources: each request uses its own short-lived socket.
  }
}

// ── Userspace USB client ────────────────────────────────────────────────────

/**
 * JRD client over userspace USB networking (CDC-ECM or RNDIS).
 *
 * Bypasses the OS network stack entirely — uses tcpip.js (lwIP WASM)
 * for TCP/IP and our own HTTP client over raw USB bulk transfers.
 * Works cross-platform without any OS network configuration.
 */
export class JrdUsbClient implements JrdClient {
  constructor(private readonly transport: UsbNetTransport) {}

  async call(method: string, params: unknown = null): Promise<unknown> {
    const body = buildJrdBody(method, params)
    const path = `/jrd/webapi?api=${method}`
    const gatewayIp = this.transport.gatewayIp

    const response = await httpPost(this.transport, path, body, {
      headers: {
        Referer: `http://${gatewayIp}/`,
        _TclRequestVerificationKey: VERIFICATION_KEY,
      },
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`JRD HTTP ${response.status} from ${method}`)
    }

    return parseJrdResponse(method, response.body)
  }

  destroy(): void {
    this.transport.close().catch(() => {})
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function buildJrdBody(method: string, params: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id: '1',
  })
}

function parseJrdResponse(method: string, responseBody: string): unknown {
  const parsed: unknown = JSON.parse(responseBody)

  // Check for error envelope first
  const errorResult = jrdErrorSchema.safeParse(parsed)
  if (errorResult.success) {
    const { code, message } = errorResult.data.error
    throw new JrdApiError(method, code, message)
  }

  // Extract result field
  const successResult = jrdSuccessSchema.safeParse(parsed)
  if (!successResult.success) {
    throw new JrdApiError(method, -1, `Unexpected response shape: ${responseBody}`)
  }

  return successResult.data.result
}

/**
 * Error from JRD API.
 *
 * Known error codes:
 * - -32698: Authentication required (not a whitelist method)
 * - -32699: Authentication failure
 */
export class JrdApiError extends Error {
  override name = 'JrdApiError'

  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`JRD ${method}: ${message} (code ${code})`)
  }
}
