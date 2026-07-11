import { z } from 'zod'

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Ussd } from '../../../../protocols/adapter.js'
import type { HiLinkHttpClient } from './client.js'
import {
  fetchHiLinkSession,
  HILINK_ERR_ACCOUNT_LOCKED,
  hilinkErrorMessage,
  loginHiLink,
} from './index.js'
import type { HiLinkCredentials } from './types.js'
import { extractHiLinkErrorCode, parseHiLinkXml } from './xml.js'

const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 30_000

// api/ussd/get returns 111019 when there is no active USSD session yet -- keep polling
const ERR_USSD_NO_SESSION = '111019'

const ussdGetResponseSchema = z.object({
  content: z.union([z.string(), z.number()]).optional(),
})

/**
 * USSD service implementation for Huawei HiLink HTTP API.
 *
 * HiLink USSD uses a page-based session (distinct from the SesTokInfo API session):
 * 1. Authenticate via api/user/login to obtain an authenticated session cookie.
 *    The firmware issues a new SessionID in Set-Cookie on successful login.
 * 2. Load html/ussd.html with the authenticated cookie to extract two rotating
 *    CSRF tokens baked into the page's <meta name="csrf_token"> tags.
 * 3. POST api/ussd/send with application/x-www-form-urlencoded (not text/xml).
 * 4. Poll api/ussd/get until the response content arrives.
 *
 * Tested on E3372h firmware; CSRF tokens rotate after each request via the
 * __RequestVerificationToken response header.
 */
export class HiLinkUssd implements Ussd {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    private readonly credentials?: HiLinkCredentials | undefined,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async send(code: string): Promise<string> {
    this._log.debug('USSD send', { code })
    const cookie = await this.authenticate()
    const { sendToken, pollToken } = await this.fetchPageTokens(cookie)
    await this.postSend(cookie, sendToken, code)
    return this.pollResponse(cookie, pollToken)
  }

  async cancel(): Promise<void> {
    const cookie = await this.authenticate()
    await this.client.postForm('api/ussd/release', cookie, '', '')
  }

  /**
   * Returns an authenticated session cookie string (e.g. "SessionID=...").
   *
   * Always attempts login — USSD send/get require an authenticated session on
   * most firmware versions, unlike monitoring endpoints which work unauthenticated.
   *
   * - With credentials: logs in with the provided username/password.
   * - Without credentials: sends the HiLink passwordless login
   *   (username='admin', password=''). This is the protocol-defined way to
   *   authenticate on devices with no password set (hilink_login=0).
   *   'admin' is the only valid username in HiLink firmware — it's a protocol
   *   constant, not a guess. Throws if the device has a password configured.
   */
  private async authenticate(): Promise<string> {
    this._log.info('Authenticating for USSD')
    const session = await fetchHiLinkSession(this.client.baseUrl)
    // HiLink passwordless login: username is always 'admin' (firmware constant),
    // empty password is the protocol-defined value for hilink_login=0 devices.
    const credentials = this.credentials ?? { password: '', username: 'admin' }

    const { errorCode, newSessionId } = await loginHiLink(this.client.baseUrl, session, credentials)

    if (errorCode === undefined) {
      this._log.info('USSD authenticated')
      return newSessionId ?? session.sessionId
    }

    this._log.error('USSD auth failed', { errorCode, message: hilinkErrorMessage(errorCode) })

    if (errorCode === HILINK_ERR_ACCOUNT_LOCKED) {
      throw new Error(
        'HiLink account locked -- too many failed login attempts. ' +
          'Unplug and replug the device to reset.',
      )
    }

    if (this.credentials === undefined) {
      throw new Error(
        'USSD requires authentication but no credentials were provided. ' +
          'Pass credentials when opening the modem.',
      )
    }

    throw new Error(`HiLink USSD: login failed: ${hilinkErrorMessage(errorCode)}`)
  }

  private async fetchPageTokens(cookie: string): Promise<{ sendToken: string; pollToken: string }> {
    const html = await this.client.getAuth('html/ussd.html', cookie)

    const tokens = [...html.matchAll(/<meta\s+name="csrf_token"\s+content="([^"]+)"/g)].map(
      (m) => m[1],
    )

    const [sendToken, pollToken] = tokens
    if (sendToken === undefined || pollToken === undefined) {
      throw new Error(
        `HiLink USSD: could not extract CSRF tokens from html/ussd.html ` +
          `(found ${tokens.length}). The session may not be authenticated.`,
      )
    }

    return { sendToken, pollToken }
  }

  private async postSend(cookie: string, csrfToken: string, code: string): Promise<void> {
    const formBody = `content=${encodeURIComponent(code)}&codeType=CodeType&timeout=`
    const responseBody = await this.client.postForm('api/ussd/send', cookie, csrfToken, formBody)

    const errCode = extractHiLinkErrorCode(responseBody)
    if (errCode !== undefined) {
      throw new Error(`HiLink USSD send failed: ${hilinkErrorMessage(errCode)}`)
    }
  }

  private async pollResponse(cookie: string, csrfToken: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let currentToken = csrfToken

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)

      const { body, nextToken } = await this.client.getWithToken(
        'api/ussd/get',
        cookie,
        currentToken,
      )
      if (nextToken !== undefined) currentToken = nextToken

      // Check for error first -- 111019 means "no session yet", keep polling
      const errCode = extractHiLinkErrorCode(body)
      if (errCode !== undefined && errCode !== ERR_USSD_NO_SESSION) {
        throw new Error(`HiLink USSD poll failed: ${hilinkErrorMessage(errCode)}`)
      }

      // Extract content from success response: <response><content>...</content></response>
      if (errCode === undefined) {
        try {
          const data = parseHiLinkXml(body, ussdGetResponseSchema)
          if (data.content !== undefined) return String(data.content)
        } catch {
          // Not a valid response yet -- continue polling
        }
      }
    }

    throw new Error(`HiLink USSD timed out after ${POLL_TIMEOUT_MS / 1000}s`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
