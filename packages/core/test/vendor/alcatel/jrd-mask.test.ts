import { describe, expect, it } from 'vitest'

import { maskJrdSecrets } from '../../../src/vendor/alcatel/protocols/jrd/mask.js'

describe('maskJrdSecrets', () => {
  it('redacts a login password but keeps the rest of the body', () => {
    const body = JSON.stringify({
      method: 'Login',
      params: { username: 'admin', password: 's3cret' },
    })
    const masked = maskJrdSecrets(body)

    expect(masked).not.toContain('s3cret')
    expect(masked).toContain('"password":"[REDACTED]"')
    expect(masked).toContain('"username":"admin"')
    expect(masked).toContain('"method":"Login"')
  })

  it('redacts token, pin, and puk values', () => {
    const body = JSON.stringify({ token: 'abc123', pin: '1234', puk: '87654321' })
    const masked = maskJrdSecrets(body)

    expect(masked).not.toMatch(/abc123|1234|87654321/)
    expect(masked).toContain('"token":"[REDACTED]"')
    expect(masked).toContain('"pin":"[REDACTED]"')
    expect(masked).toContain('"puk":"[REDACTED]"')
  })

  it('redacts a numeric (unquoted) pin value', () => {
    const masked = maskJrdSecrets('{"method":"UnlockPin","pin":1234}')
    expect(masked).not.toContain('1234')
    expect(masked).toContain('"pin":"[REDACTED]"')
  })

  it('redacts compound key names like wifiPassword', () => {
    const masked = maskJrdSecrets(JSON.stringify({ wifiPassword: 'hunter2' }))
    expect(masked).not.toContain('hunter2')
    expect(masked).toContain('"wifiPassword":"[REDACTED]"')
  })

  it('does NOT mask SMS content -- messaging is the device purpose', () => {
    const body = JSON.stringify({
      method: 'SendSMS',
      SMSContent: 'your code is 1234',
      PhoneNumber: '+37499',
    })
    const masked = maskJrdSecrets(body)

    expect(masked).toContain('"SMSContent":"your code is 1234"')
    expect(masked).toContain('"PhoneNumber":"+37499"')
  })

  it('leaves a body with no secrets unchanged', () => {
    const body = JSON.stringify({ method: 'GetSystemInfo', params: null, id: '1' })
    expect(maskJrdSecrets(body)).toBe(body)
  })
})
