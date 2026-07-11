/**
 * Low-level HTTP request helpers for HiLink XML API.
 *
 * Handles timeout, CSRF token rotation on POST responses,
 * and Set-Cookie capture for session upgrades after login.
 */

import { DiscoveryError } from '../../../../errors.js'
import type { HiLinkSession } from './types.js'

const FETCH_TIMEOUT_MS = 10_000

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>'

export function withCsrfToken(session: HiLinkSession, csrfToken: string): HiLinkSession {
  return { sessionId: session.sessionId, csrfToken }
}

export async function hiLinkGet(baseUrl: string, path: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/${path}`, { signal: controller.signal })
    if (!response.ok) {
      throw new DiscoveryError(`HiLink request to ${path} failed: HTTP ${response.status}`)
    }
    return await response.text()
  } catch (err: unknown) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(
      `HiLink device at ${baseUrl} is unreachable. ` +
        `Ensure the device is connected and 192.168.8.1 is accessible.`,
      { cause: err },
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function hiLinkPost(
  baseUrl: string,
  session: HiLinkSession,
  path: string,
  body: string,
): Promise<{ body: string; nextCsrfToken: string | undefined; newSessionId: string | undefined }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        Cookie: session.sessionId,
        __RequestVerificationToken: session.csrfToken,
        'Content-Type': 'text/xml',
      },
      body,
      signal: controller.signal,
    })

    const rawCsrfHeader = response.headers.get('__RequestVerificationToken') ?? undefined
    const [firstToken] = rawCsrfHeader?.split('#') ?? []
    const nextCsrfToken = firstToken?.trim() || undefined

    // Some responses (notably /api/user/login) issue a new authenticated session
    // via Set-Cookie. Capture it so callers can use the updated session ID.
    const setCookieRaw = response.headers.get('set-cookie') ?? ''
    const [, rawSessionId] = /SessionID=([^;,\s]+)/.exec(setCookieRaw) ?? []
    const newSessionId = rawSessionId !== undefined ? `SessionID=${rawSessionId}` : undefined

    const respBody = await response.text()
    return { body: respBody, nextCsrfToken, newSessionId }
  } catch (err: unknown) {
    if (err instanceof DiscoveryError) throw err
    throw new DiscoveryError(`HiLink POST to ${path} failed.`, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}
