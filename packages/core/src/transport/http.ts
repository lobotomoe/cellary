/**
 * Minimal HTTP/1.1 client over raw TCP connections.
 *
 * Not a general-purpose HTTP client — serves exactly one purpose:
 * talk to device management APIs over userspace USB networking
 * (RNDIS or CDC-ECM via tcpip.js).
 *
 * Uses TcpConnection from tcpip.js (ReadableStream/WritableStream).
 */
import type { TcpConnection } from 'tcpip'
import type { UsbNetTransport } from './usb-net.js'

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

const MAX_RESPONSE_SIZE = 64 * 1024
const READ_TIMEOUT_MS = 10_000
const CONNECT_TIMEOUT_MS = 10_000

/**
 * Sentinel used to distinguish timeout rejections from stream errors
 * (FIN/close) in readToEnd's Promise.race.
 */
const READ_TIMEOUT = Symbol('readTimeout')

export interface HttpResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: ReadonlyMap<string, string>
  readonly body: string
}

/**
 * Send an HTTP POST request through a USB network transport.
 *
 * Opens a new TCP connection for each request (Connection: close).
 * The response body is fully buffered before returning.
 */
export async function httpPost(
  transport: UsbNetTransport,
  path: string,
  body: string,
  options?: { host?: string | undefined; headers?: Record<string, string> | undefined } | undefined,
): Promise<HttpResponse> {
  const targetHost = options?.host ?? transport.gatewayIp
  const conn = await connectWithTimeout(transport, targetHost, 80)

  try {
    const extraHeaders = options?.headers ?? {}
    const headerLines = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)

    const request = [
      `POST ${path} HTTP/1.1`,
      `Host: ${targetHost}`,
      'Content-Type: application/json',
      `Content-Length: ${TEXT_ENCODER.encode(body).length}`,
      'Connection: close',
      ...headerLines,
      '',
      body,
    ].join('\r\n')

    // Send request
    const writer = conn.writable.getWriter()
    await writer.write(TEXT_ENCODER.encode(request))
    writer.releaseLock()

    // Read response — server sends FIN after body, which tcpip.js may
    // surface as an error. Capture whatever we received before that.
    const chunks = await readToEnd(conn.readable)
    return parseHttpResponse(chunks)
  } finally {
    await conn.close().catch(() => {})
  }
}

/**
 * Send an HTTP GET request through a USB network transport.
 */
export async function httpGet(
  transport: UsbNetTransport,
  path: string,
  options?: { host?: string | undefined; headers?: Record<string, string> | undefined } | undefined,
): Promise<HttpResponse> {
  const targetHost = options?.host ?? transport.gatewayIp
  const conn = await connectWithTimeout(transport, targetHost, 80)

  try {
    const extraHeaders = options?.headers ?? {}
    const headerLines = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)

    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${targetHost}`,
      'Connection: close',
      ...headerLines,
      '',
      '',
    ].join('\r\n')

    const writer = conn.writable.getWriter()
    await writer.write(TEXT_ENCODER.encode(request))
    writer.releaseLock()

    const chunks = await readToEnd(conn.readable)
    return parseHttpResponse(chunks)
  } finally {
    await conn.close().catch(() => {})
  }
}

// ── Connect with timeout ─────────────────────────────────────────────────

/**
 * Connect to the device with a timeout. lwIP's connectTcp() has no built-in
 * deadline — if the SYN never gets a response, it hangs forever.
 *
 * When the timeout fires, the underlying connectTcp() promise is still
 * in-flight inside lwIP. If it eventually resolves, we must close the
 * orphaned connection — otherwise the TCP PCB leaks and the device may
 * stall processing abandoned state.
 */
async function connectWithTimeout(
  transport: UsbNetTransport,
  host: string,
  port: number,
): Promise<TcpConnection> {
  const connectPromise = transport.connectTcp(host, port)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
  }, CONNECT_TIMEOUT_MS)
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(new Error(`TCP connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    )
  })

  try {
    const conn = await Promise.race([connectPromise, deadline])
    clearTimeout(timer)
    return conn
  } catch (err: unknown) {
    // Clean up orphaned connection if it resolves after we've timed out.
    // Without this, the TCP PCB leaks inside lwIP and the device may
    // stall processing abandoned state.
    cleanupOrphanedConnection(connectPromise, timedOut)
    throw err
  }
}

/**
 * If connectTcp eventually succeeds after a timeout, close the orphaned
 * connection so it doesn't leak inside lwIP.
 */
function cleanupOrphanedConnection(
  connectPromise: Promise<TcpConnection>,
  wasTimedOut: boolean,
): void {
  if (!wasTimedOut) return
  connectPromise.then((conn) => conn.close()).catch(() => {})
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Read all available data from a ReadableStream, tolerating close/error.
 *
 * tcpip.js surfaces TCP FIN as a stream error rather than a clean end.
 * We capture whatever was received before the error. With Connection: close
 * the server always sends FIN after the response body, so this is expected.
 *
 * A deadline races against each reader.read() call — if the device dies
 * mid-request (thermal reboot, USB disconnect), the read would hang
 * forever without this.
 */
async function readToEnd(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let totalSize = 0
  const reader = readable.getReader()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(READ_TIMEOUT), READ_TIMEOUT_MS)
  })

  try {
    while (totalSize < MAX_RESPONSE_SIZE) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      chunks.push(value)
      totalSize += value.length
    }
  } catch (err: unknown) {
    if (err === READ_TIMEOUT) {
      // Unblock the pending read so the stream can be cleaned up
      reader.cancel().catch(() => {})
      throw new Error(`HTTP read timed out after ${READ_TIMEOUT_MS}ms`, { cause: err })
    }
    // FIN or connection close — expected with Connection: close
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try {
      reader.releaseLock()
    } catch {
      /* may have pending read after cancel */
    }
  }

  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/**
 * Parse a raw HTTP/1.1 response. Tolerant of the bare-LF line endings some
 * embedded device servers emit (e.g. Alcatel JRD firmware) instead of CRLF.
 * Shared by the USB (lwIP) and OS (raw TCP) JRD transports.
 */
export function parseHttpResponse(data: Uint8Array): HttpResponse {
  const raw = TEXT_DECODER.decode(data)

  // Split headers and body. Try standard \r\n\r\n first, fall back to \n\n
  // for non-compliant embedded HTTP servers (e.g. Alcatel JRD firmware).
  let headerEnd = raw.indexOf('\r\n\r\n')
  let separatorLen = 4
  let lineBreak = '\r\n'

  if (headerEnd === -1) {
    headerEnd = raw.indexOf('\n\n')
    separatorLen = 2
    lineBreak = '\n'
  }

  if (headerEnd === -1) {
    return { status: 0, statusText: 'Malformed response', headers: new Map(), body: raw }
  }

  const headerSection = raw.slice(0, headerEnd)
  const bodySection = raw.slice(headerEnd + separatorLen)

  const lines = headerSection.split(lineBreak)
  const statusLine = lines[0] ?? ''

  // Parse "HTTP/1.1 200 OK"
  const statusMatch = /^HTTP\/\d\.\d\s+(\d+)\s+(.*)$/.exec(statusLine)
  const status = statusMatch ? parseInt(statusMatch[1] ?? '0', 10) : 0
  const statusText = statusMatch ? (statusMatch[2] ?? '') : statusLine

  const headers = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()
    headers.set(key, value)
  }

  return { status, statusText, headers, body: bodySection }
}
