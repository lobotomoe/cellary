/**
 * Shared types for HiLink protocol modules.
 *
 * Neutral file — breaks the circular dependency between http.ts (request helpers)
 * and session.ts (session management), both of which need HiLinkSession.
 */

export interface HiLinkSession {
  /** Raw SesInfo value from /api/webserver/SesTokInfo, used as Cookie header */
  readonly sessionId: string
  /** CSRF token from /api/webserver/SesTokInfo, sent as __RequestVerificationToken */
  readonly csrfToken: string
}

export interface HiLinkCredentials {
  /** Plaintext admin password. */
  readonly password: string
  /** Username. Defaults to 'admin' when absent. */
  readonly username?: string | undefined
}
