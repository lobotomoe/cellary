import { describe, expect, it } from 'vitest'

import { assertMethodAllowed, MethodForbiddenError } from '../src/authz.js'

describe('assertMethodAllowed', () => {
  it('blocks shell methods when allowShell is false', () => {
    const policy = { allowShell: false }
    expect(() => assertMethodAllowed('system.shell', policy)).toThrow(MethodForbiddenError)
    expect(() => assertMethodAllowed('stream.open', policy)).toThrow(MethodForbiddenError)
  })

  it('allows shell methods when allowShell is true', () => {
    const policy = { allowShell: true }
    expect(() => assertMethodAllowed('system.shell', policy)).not.toThrow()
    expect(() => assertMethodAllowed('stream.open', policy)).not.toThrow()
  })

  it('always allows non-privileged methods, regardless of policy', () => {
    for (const policy of [{ allowShell: false }, { allowShell: true }]) {
      expect(() => assertMethodAllowed('devices.list', policy)).not.toThrow()
      expect(() => assertMethodAllowed('sms.send', policy)).not.toThrow()
      expect(() => assertMethodAllowed('daemon.status', policy)).not.toThrow()
    }
  })

  it('names CELLARY_ALLOW_SHELL in the error so operators can enable it', () => {
    try {
      assertMethodAllowed('system.shell', { allowShell: false })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MethodForbiddenError)
      if (err instanceof MethodForbiddenError) {
        expect(err.message).toContain('CELLARY_ALLOW_SHELL')
      }
    }
  })
})
