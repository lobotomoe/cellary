/**
 * HiLink session management, authentication, and password hashing.
 *
 * Session flow:
 * 1. GET /api/webserver/SesTokInfo -> session cookie + CSRF token
 * 2. Use Cookie: <SesInfo> and __RequestVerificationToken: <TokInfo>
 * 3. CSRF token rotates per response (first segment of "#"-separated list)
 */

import { z } from 'zod'

import { type AuditSink, noopAuditSink } from '../../../../audit.js'
import { DiscoveryError } from '../../../../errors.js'
import { hiLinkGet, hiLinkPost, XML_HEADER } from './http.js'
import type { HiLinkCredentials, HiLinkSession } from './types.js'
import { extractHiLinkErrorCode, parseHiLinkXml } from './xml.js'

// ── Crypto ───────────────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashBytes = new Uint8Array(hashBuffer)
  return Array.from(hashBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Compute the HiLink type-4 password hash.
 *
 * Formula (confirmed on E8372H-153 fw 21.328.03.00.00):
 *   inner    = sha256(password)                      -> lowercase hex string
 *   inner_b64 = base64(inner)                        -> base64 of the hex string
 *   outer    = sha256(username + inner_b64 + token)  -> lowercase hex string
 *   result   = base64(outer)                         -> base64 of the hex string
 *
 * Both SHA-256 outputs are encoded as ASCII hex strings before base64-encoding.
 * Uses Web Crypto API (crypto.subtle) for isomorphic Node.js / browser support.
 */
export async function hashHiLinkPassword(
  password: string,
  token: string,
  username = 'admin',
): Promise<string> {
  const innerHex = await sha256Hex(password)
  const b64Inner = btoa(innerHex)
  const outerHex = await sha256Hex(username + b64Inner + token)
  return btoa(outerHex)
}

// ── Session management ──────────────────────────────────────────────────────

/**
 * Fetch a fresh HiLink session token.
 *
 * Tokens rotate after each request -- always fetch a new session before
 * making an API call rather than caching it.
 *
 * @throws {DiscoveryError} If the device is unreachable or the response is malformed.
 */
const sesTokSchema = z.object({
  SesInfo: z.string(),
  TokInfo: z.string(),
})

export async function fetchHiLinkSession(baseUrl: string): Promise<HiLinkSession> {
  const text = await hiLinkGet(baseUrl, 'api/webserver/SesTokInfo')

  try {
    const data = parseHiLinkXml(text, sesTokSchema)
    return { sessionId: data.SesInfo, csrfToken: data.TokInfo }
  } catch (err: unknown) {
    throw new DiscoveryError(
      `HiLink session response is missing token fields. ` +
        `Is ${baseUrl} a HiLink device? Response: ${text.slice(0, 200)}`,
      { cause: err },
    )
  }
}

// ── Authentication ──────────────────────────────────────────────────────────

/**
 * Log in to a HiLink device using username/password credentials.
 *
 * Uses password type 4 (confirmed on E8372H-153): the hash formula is
 * base64(hex_sha256(username + base64(hex_sha256(password)) + token)).
 *
 * On success the __RequestVerificationToken response header carries the next
 * CSRF token. Pass it as csrfToken on the immediately following request
 * instead of fetching a new session.
 *
 * Error 108006 = account locked (exceeded failed attempts). The lockout
 * counter is RAM-only and resets when the device loses power.
 *
 * @returns nextCsrfToken (first segment from response header) and errorCode.
 *   errorCode is undefined when login succeeded; a numeric string when it failed.
 */
export async function loginHiLink(
  baseUrl: string,
  session: HiLinkSession,
  credentials: HiLinkCredentials,
  auditSink: AuditSink = noopAuditSink,
): Promise<{
  nextCsrfToken: string | undefined
  errorCode: string | undefined
  /** New session ID from Set-Cookie, if the firmware issued one after authentication. */
  newSessionId: string | undefined
}> {
  const { password, username = 'admin' } = credentials
  const hashedPassword = await hashHiLinkPassword(password, session.csrfToken, username)

  const body =
    `${XML_HEADER}<request>` +
    `<Username>${username}</Username>` +
    `<Password>${hashedPassword}</Password>` +
    `<password_type>4</password_type>` +
    `</request>`

  const {
    body: respBody,
    nextCsrfToken,
    newSessionId,
  } = await hiLinkPost(baseUrl, session, 'api/user/login', body, auditSink)
  const errorCode = extractHiLinkErrorCode(respBody)

  return { nextCsrfToken, errorCode, newSessionId }
}
