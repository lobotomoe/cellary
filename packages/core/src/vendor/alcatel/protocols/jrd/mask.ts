/**
 * Redact credentials from JRD JSON request/response bodies before they are
 * logged or audited. JRD carries login passwords and SIM PIN/PUK codes as JSON
 * string values; we redact any key containing password/token/pin/puk and leave
 * the rest intact. SMS content is NOT masked -- messaging is the device's job.
 */
const REDACTED = '[REDACTED]'
const SECRET_KEY_REGEX = /("[\w-]*(?:password|token|pin|puk)[\w-]*"\s*:\s*)("[^"]*"|[^,}]+)/gi
export function maskJrdSecrets(json: string): string {
  return json.replace(SECRET_KEY_REGEX, `$1"${REDACTED}"`)
}
