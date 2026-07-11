/**
 * HiLink mode switching (HiLink HTTP mode -> AT/modem mode).
 *
 * Strategy:
 * 1. POST /api/device/mode with mode=1 (unauthenticated)
 * 2. If 100003 (auth required): log in and retry
 * 3. If 125002 (endpoint blocked): fall back to CGI switchMode(0)
 *
 * Note: on E8372H-153 fw 21.328.03.00.00 the CGI path produces PID 0x1442
 * (storage PID for this variant), not 0x1566 directly. The caller must
 * follow with HUAWEI_VENDOR_SWITCH to complete the transition.
 */

import { DiscoveryError } from '../../../../errors.js'
import { hiLinkPost, withCsrfToken, XML_HEADER } from './http.js'
import { fetchHiLinkSession, loginHiLink } from './session.js'
import type { HiLinkCredentials, HiLinkSession } from './types.js'
import { extractHiLinkErrorCode } from './xml.js'

const ERR_NOT_FOUND = '100002'
const ERR_AUTH_REQUIRED = '100003'
const ERR_ACCOUNT_LOCKED = '108006'
const ERR_MODE_NOT_SUPPORTED = '125002'

/**
 * Request the HiLink device to switch from HiLink (HTTP) mode to AT/modem mode.
 *
 * @param credentials - Required when the device has a password set.
 *   If omitted and auth is required, throws with a user-facing message.
 *
 * @throws {DiscoveryError} If the API returns an unrecoverable error or
 *   the device is unreachable.
 */
export async function requestHiLinkModeSwitch(
  baseUrl: string,
  credentials?: HiLinkCredentials,
): Promise<void> {
  const session = await fetchHiLinkSession(baseUrl)
  const modeBody = `${XML_HEADER}<request><mode>1</mode></request>`

  const { body: firstBody, nextCsrfToken: firstNextToken } = await hiLinkPost(
    baseUrl,
    session,
    'api/device/mode',
    modeBody,
  )
  const firstCode = extractHiLinkErrorCode(firstBody)

  if (firstCode === undefined) return

  if (firstCode === ERR_AUTH_REQUIRED) {
    await switchWithAuth(baseUrl, session, modeBody, firstNextToken, credentials)
    return
  }

  if (firstCode === ERR_MODE_NOT_SUPPORTED) {
    await requestHiLinkModeSwitchCgi(baseUrl, session)
    return
  }

  if (firstCode === ERR_NOT_FOUND) {
    throw new DiscoveryError(
      `HiLink mode switch endpoint not found on device at ${baseUrl}. ` +
        `The device firmware may not support remote mode switching.`,
    )
  }

  throw new DiscoveryError(
    `HiLink mode switch returned error ${firstCode}. ` +
      `Try switching manually at ${baseUrl} > Settings > Device mode.`,
  )
}

async function switchWithAuth(
  baseUrl: string,
  session: HiLinkSession,
  modeBody: string,
  firstNextToken: string | undefined,
  credentials: HiLinkCredentials | undefined,
): Promise<void> {
  if (credentials === undefined) {
    throw new DiscoveryError(
      `HiLink mode switch at ${baseUrl} requires authentication. ` +
        `Provide credentials or log in at ${baseUrl} and try again.`,
    )
  }

  const {
    nextCsrfToken: loginToken,
    errorCode: loginCode,
    newSessionId: loginNewId,
  } = await loginHiLink(baseUrl, session, credentials)

  if (loginCode === ERR_ACCOUNT_LOCKED) {
    throw new DiscoveryError(
      `HiLink account is locked at ${baseUrl}. ` +
        `Unplug and replug the device to reset the lockout counter, then try again.`,
    )
  }

  if (loginCode !== undefined) {
    throw new DiscoveryError(`HiLink login at ${baseUrl} failed with error ${loginCode}.`)
  }

  // Prefer the CSRF token the mode POST already rotated to, fall back to login's token.
  const retryToken = firstNextToken ?? loginToken
  if (retryToken === undefined) {
    throw new DiscoveryError(`HiLink login at ${baseUrl} succeeded but no CSRF token was returned.`)
  }

  // Use the new session ID from Set-Cookie if the firmware issued one after login.
  const authenticatedSession = {
    sessionId: loginNewId ?? session.sessionId,
    csrfToken: retryToken,
  }
  const { body: retryBody, nextCsrfToken: retryNextToken } = await hiLinkPost(
    baseUrl,
    authenticatedSession,
    'api/device/mode',
    modeBody,
  )
  const retryCode = extractHiLinkErrorCode(retryBody)

  if (retryCode === undefined) return

  if (retryCode === ERR_MODE_NOT_SUPPORTED) {
    // Use the most-recently rotated token for the CGI call.
    const cgiToken = retryNextToken ?? retryToken
    await requestHiLinkModeSwitchCgi(baseUrl, withCsrfToken(authenticatedSession, cgiToken))
    return
  }

  throw new DiscoveryError(
    `HiLink mode switch (post-login) returned error ${retryCode}. ` +
      `Try switching manually at ${baseUrl} > Settings > Device mode.`,
  )
}

/**
 * Request mode switch via the legacy CGI endpoint.
 *
 * POSTs to /CGI with <function>switchMode</function><switchType>0</switchType>.
 * On E8372H-153 fw 21.328.03.00.00 this produces PID 0x1442 (storage PID for
 * this firmware variant), not 0x1566 directly. A subsequent
 * HUAWEI_VENDOR_SWITCH transfer from PID 0x1442 boots to modem mode.
 *
 * Called as fallback inside requestHiLinkModeSwitch when /api/device/mode
 * returns 125002 (ERR_MODE_NOT_SUPPORTED).
 */
async function requestHiLinkModeSwitchCgi(baseUrl: string, session: HiLinkSession): Promise<void> {
  const body =
    `${XML_HEADER}<api version="1.0">` +
    `<header><function>switchMode</function></header>` +
    `<body><request><switchType>0</switchType></request></body>` +
    `</api>`

  const { body: respBody } = await hiLinkPost(baseUrl, session, 'CGI', body)
  const errorCode = extractHiLinkErrorCode(respBody)

  if (errorCode !== undefined) {
    throw new DiscoveryError(`HiLink CGI switchMode returned error ${errorCode}.`)
  }
}
