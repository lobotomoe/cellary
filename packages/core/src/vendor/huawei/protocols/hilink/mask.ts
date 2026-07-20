/**
 * Redact credentials from HiLink XML request/response bodies before they are
 * logged or audited. HiLink carries login password hashes and SIM PIN/PUK codes
 * inside XML tags; we redact the inner text of the secret-bearing tags and keep
 * tag structure so a request stays diagnosable. SMS <Content> is NOT masked --
 * messaging is the device's purpose.
 */
const REDACTED = '[REDACTED]'
const SECRET_TAG_REGEX = /<(Password|Pin|CurrentPin|NewPin|Puk|NewPuk)>[^<]*<\/\1>/gi
export function maskHiLinkSecrets(xml: string): string {
  return xml.replace(SECRET_TAG_REGEX, `<$1>${REDACTED}</$1>`)
}
