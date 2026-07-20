/**
 * Redact credentials from AT command/response text before it is logged or
 * persisted.
 *
 * SIM PINs/PUKs and lock passwords travel in the clear inside AT commands
 * (`AT+CPIN="1234"`, `AT+CPWD=...`, `AT+CLCK=...`). Without masking they land
 * verbatim in debug logs and any device-comms audit -- a hard "never log
 * secrets" violation. We redact only the parameter value and keep the command
 * name so a failure is still diagnosable ("a CPIN set failed") without exposing
 * the secret.
 *
 * Over-redaction is deliberate: for the credential-bearing commands the whole
 * argument list after `=` is redacted (including non-secret positional args like
 * a CLCK facility) so a secret can never leak through an unparsed edge. A bare
 * query (`AT+CPIN?`) and a status response (`+CPIN: READY`) carry no `=` value
 * and are left intact.
 *
 * SMS content is NOT masked here: reading/sending messages is the device's
 * purpose, so its payload is not a secret to hide at this layer.
 */

const REDACTED = '[REDACTED]'

// Credential-bearing set commands. Matches an optional `AT` lead-in, the `+`/`^`
// introducer, the command token, then `=<value>`; the value is redacted.
const SENSITIVE_AT_REGEX = /((?:AT)?[+^](?:CPIN2?|CPWD|CLCK|CACM|DATALOCK)=)[^\r\n]+/gi

/** Return `line` with any AT credential value replaced by `[REDACTED]`. */
export function maskAtSecrets(line: string): string {
  return line.replace(SENSITIVE_AT_REGEX, `$1${REDACTED}`)
}
