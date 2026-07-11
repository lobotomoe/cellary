import { fetchHiLinkSession } from './index.js'

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Shared HTTP client for HiLink API requests.
 *
 * Centralizes session management, timeout handling, and error wrapping
 * that was previously duplicated across every HiLink service file.
 */
export class HiLinkHttpClient {
  constructor(
    readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** GET with an unauthenticated session (session cookie + CSRF token). */
  async get(path: string, timeoutMs?: number | undefined): Promise<string> {
    const session = await fetchHiLinkSession(this.baseUrl)
    const result = await this.request(path, {
      headers: {
        Cookie: session.sessionId,
        __RequestVerificationToken: session.csrfToken,
      },
      timeoutMs,
    })
    return result.text
  }

  /** GET with a pre-authenticated cookie (no CSRF needed). */
  async getAuth(path: string, cookie: string, timeoutMs?: number | undefined): Promise<string> {
    const result = await this.request(path, { headers: { Cookie: cookie }, timeoutMs })
    return result.text
  }

  /**
   * GET with Cookie + CSRF token. Returns body and the rotated CSRF token
   * from the __RequestVerificationToken response header (HiLink token rotation).
   */
  async getWithToken(
    path: string,
    cookie: string,
    csrfToken: string,
  ): Promise<{ body: string; nextToken: string | undefined }> {
    const result = await this.request(path, {
      headers: { Cookie: cookie, __RequestVerificationToken: csrfToken },
    })
    const rawHeader = result.responseHeaders.get('__RequestVerificationToken') ?? undefined
    const [firstToken] = rawHeader?.split('#') ?? []
    const nextToken = firstToken?.trim() || undefined
    return { body: result.text, nextToken }
  }

  /** POST form-urlencoded with Cookie + CSRF token. Returns response body. */
  async postForm(path: string, cookie: string, csrfToken: string, body: string): Promise<string> {
    const result = await this.request(path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        __RequestVerificationToken: csrfToken,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    })
    return result.text
  }

  private async request(
    path: string,
    init: {
      readonly headers: Record<string, string>
      readonly method?: string
      readonly body?: string
      readonly timeoutMs?: number | undefined
    },
  ): Promise<{ text: string; responseHeaders: Headers }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs)

    try {
      const fetchInit: RequestInit = {
        method: init.method ?? 'GET',
        signal: controller.signal,
        headers: init.headers,
      }
      if (init.body !== undefined) fetchInit.body = init.body
      const response = await globalThis.fetch(`${this.baseUrl}/${path}`, fetchInit)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const text = await response.text()
      return { text, responseHeaders: response.headers }
    } catch (err: unknown) {
      throw new Error(`HiLink request to ${path} failed`, { cause: err })
    } finally {
      clearTimeout(timer)
    }
  }
}
