import { describe, expect, it } from 'vitest'
import { parseHttpResponse } from '../../src/transport/http.js'

const encode = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('parseHttpResponse', () => {
  it('parses a standard CRLF response', () => {
    const raw = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'
    const res = parseHttpResponse(encode(raw))
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.body).toBe('{"ok":true}')
  })

  it('parses a bare-LF response (Alcatel JRD firmware emits \\n, not \\r\\n)', () => {
    const raw = 'HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: 11\n\n{"ok":true}'
    const res = parseHttpResponse(encode(raw))
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('content-length')).toBe('11')
    expect(res.body).toBe('{"ok":true}')
  })

  it('reports a malformed response with no header separator', () => {
    const raw = '{ "jsonrpc": "2.0", "error": { "code": "-32700" } }'
    const res = parseHttpResponse(encode(raw))
    expect(res.status).toBe(0)
    expect(res.statusText).toBe('Malformed response')
    expect(res.body).toBe(raw)
  })
})
