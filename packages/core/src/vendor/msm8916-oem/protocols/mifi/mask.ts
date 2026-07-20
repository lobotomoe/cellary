/**
 * Redact credentials from MiFi HTTP JSON bodies before they are logged or
 * audited.
 *
 * The MiFi API carries login passwords, WiFi passphrases, SIM PIN/PUK codes,
 * and session tokens as JSON string values. Without masking they would land in
 * the device-comms audit -- a "never log secrets" violation. We redact the
 * value of any key whose name contains password/token/pin/puk and keep the
 * rest of the body intact so a request stays diagnosable.
 *
 * SMS content (keys like `content`, `message`, `number`) is NOT masked:
 * sending/reading messages is the device's purpose, not a secret to hide here.
 */

const REDACTED = '[REDACTED]'

// Matches a secret-bearing JSON key (any key containing password/token/pin/puk,
// case-insensitive) and its value -- a quoted string or a bare literal up to the
// next delimiter -- and replaces the value with a redacted string.
const SECRET_KEY_REGEX = /("[\w-]*(?:password|token|pin|puk)[\w-]*"\s*:\s*)("[^"]*"|[^,}]+)/gi

/** Return `json` with any secret-bearing value replaced by `[REDACTED]`. */
export function maskMifiSecrets(json: string): string {
  return json.replace(SECRET_KEY_REGEX, `$1"${REDACTED}"`)
}
