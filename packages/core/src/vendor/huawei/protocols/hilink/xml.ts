/**
 * HiLink XML response parsing pipeline.
 *
 * Uses fast-xml-parser to convert XML to JS objects, then Zod to validate.
 * Every HiLink endpoint gets a schema — no more regex-based tag extraction.
 *
 * Usage:
 *   const data = parseHiLinkXml(xmlString, signalSchema)
 *   // data is fully typed and validated
 *
 * Error responses (<error><code>N</code>...</error>) are detected automatically
 * and thrown as HiLinkApiError before Zod validation runs.
 */

import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

// ── Error code descriptions ──────────────────────────────────────────────────

const ERROR_DESCRIPTIONS: Record<string, string> = {
  // System / general
  '100001': 'Unknown error',
  '100002': 'Endpoint not available on this firmware',
  '100003': 'Authentication required',
  '100004': 'System busy',
  '100005': 'Missing or invalid parameters',
  '100006': 'Parameter error',
  '100007': 'Save config file error',
  '100008': 'Get config file error',
  // SIM
  '101001': 'No SIM card or invalid SIM card',
  '101002': 'SIM card PIN locked',
  '101003': 'SIM card PUK locked',
  // Auth
  '108001': 'Wrong username',
  '108002': 'Wrong password',
  '108006': 'Account locked — too many failed login attempts',
  // USSD
  '111019': 'No active USSD session',
  // Network
  '112005': 'Network registration failed',
  '112006': 'Network connection order mismatch',
  '112007': 'Current mode does not support this operation',
  '112008': 'SIM card not ready — cannot perform network operation',
  '112009': 'Memory allocation failed',
  // SMS
  '113036': 'SMS delete failed',
  // Session / CSRF
  '125001': 'Wrong CSRF token',
  '125002': 'Endpoint blocked by firmware policy',
  '125003': 'Invalid session token',
}

/**
 * Convert a HiLink numeric error code into a human-readable message.
 * Falls back to a generic "HiLink error N" when the code is unknown.
 */
export function hilinkErrorMessage(code: string): string {
  const desc = ERROR_DESCRIPTIONS[code]
  return desc !== undefined ? `${desc} (${code})` : `HiLink error ${code}`
}

// ── XML parser instance ─────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  // Parse numeric-looking strings as numbers (e.g. <rssi>-67</rssi> -> -67)
  parseTagValue: true,
  // Don't trim whitespace from text nodes — preserves operator names etc.
  trimValues: false,
})

// ── Error detection ─────────────────────────────────────────────────────────

export class HiLinkApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HiLinkApiError'
  }
}

const errorResponseSchema = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]),
    message: z.string().optional(),
  }),
})

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a HiLink XML response and validate against a Zod schema.
 *
 * Automatically detects error responses and throws HiLinkApiError.
 * The schema should describe the contents of the <response> wrapper.
 *
 * @example
 * ```ts
 * const signalSchema = z.object({ rssi: z.number().optional() })
 * const data = parseHiLinkXml(xml, signalSchema)
 * // data.rssi is number | undefined, fully validated
 * ```
 */
export function parseHiLinkXml<T>(xml: string, schema: z.ZodType<T>): T {
  const parsed = xmlParser.parse(xml)

  // Check for error response first
  const errorResult = errorResponseSchema.safeParse(parsed)
  if (errorResult.success) {
    const code = String(errorResult.data.error.code)
    throw new HiLinkApiError(code, hilinkErrorMessage(code))
  }

  // Extract response body — HiLink wraps everything in <response>...</response>
  const response = parsed?.response
  if (response === undefined) {
    // Some endpoints return raw structures without <response> wrapper
    return schema.parse(parsed)
  }

  return schema.parse(response)
}

/**
 * Extract an error code from a HiLink XML response without throwing.
 *
 * Returns the error code string if the response is an error envelope,
 * or undefined for success responses. Used in control-flow contexts
 * where the caller branches on specific error codes (e.g. 100003 -> auth,
 * 125002 -> CGI fallback) rather than throwing immediately.
 */
export function extractHiLinkErrorCode(xml: string): string | undefined {
  const parsed = xmlParser.parse(xml)
  const errorResult = errorResponseSchema.safeParse(parsed)
  if (errorResult.success) {
    return String(errorResult.data.error.code)
  }
  return undefined
}

/**
 * Parse XML into a raw JS object without schema validation.
 * Used for one-off extractions (session tokens, error codes) where
 * a full Zod schema would be overkill.
 */
export function parseXmlRaw(xml: string): Record<string, unknown> {
  return xmlParser.parse(xml)
}
