import { describe, expect, it } from 'vitest'

import { maskMifiSecrets } from '../../../src/vendor/msm8916-oem/protocols/mifi/mask.js'

describe('maskMifiSecrets', () => {
  it('redacts a login password but keeps the rest of the body', () => {
    const body = JSON.stringify({ funcNo: 1000, username: 'admin', password: 's3cret' })
    const masked = maskMifiSecrets(body)

    expect(masked).not.toContain('s3cret')
    expect(masked).toContain('"password":"[REDACTED]"')
    expect(masked).toContain('"username":"admin"')
    expect(masked).toContain('"funcNo":1000')
  })

  it('redacts token, pin, and puk values', () => {
    const body = JSON.stringify({ token: 'abc123', pin: '1234', puk: '87654321' })
    const masked = maskMifiSecrets(body)

    expect(masked).not.toMatch(/abc123|1234|87654321/)
    expect(masked).toContain('"token":"[REDACTED]"')
    expect(masked).toContain('"pin":"[REDACTED]"')
    expect(masked).toContain('"puk":"[REDACTED]"')
  })

  it('redacts a numeric (unquoted) pin value', () => {
    const masked = maskMifiSecrets('{"funcNo":5,"pin":1234}')
    expect(masked).not.toContain('1234')
    expect(masked).toContain('"pin":"[REDACTED]"')
  })

  it('redacts compound key names like wifiPassword', () => {
    const masked = maskMifiSecrets(JSON.stringify({ wifiPassword: 'hunter2' }))
    expect(masked).not.toContain('hunter2')
    expect(masked).toContain('"wifiPassword":"[REDACTED]"')
  })

  it('does NOT mask SMS content -- messaging is the device purpose', () => {
    const body = JSON.stringify({ funcNo: 2000, number: '+37499', content: 'your code is 1234' })
    const masked = maskMifiSecrets(body)

    expect(masked).toContain('"content":"your code is 1234"')
    expect(masked).toContain('"number":"+37499"')
  })

  it('leaves a body with no secrets unchanged', () => {
    const body = JSON.stringify({ funcNo: 10, signal: 4, network: 'LTE' })
    expect(maskMifiSecrets(body)).toBe(body)
  })
})
