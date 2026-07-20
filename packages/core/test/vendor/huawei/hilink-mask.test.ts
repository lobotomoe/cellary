import { describe, expect, it } from 'vitest'

import { maskHiLinkSecrets } from '../../../src/vendor/huawei/protocols/hilink/mask.js'

describe('maskHiLinkSecrets', () => {
  it('redacts the inner text of a Password tag but keeps the tag', () => {
    const xml = '<request><Username>admin</Username><Password>aGFzaGVkcHc=</Password></request>'
    const masked = maskHiLinkSecrets(xml)

    expect(masked).not.toContain('aGFzaGVkcHc=')
    expect(masked).toContain('<Password>[REDACTED]</Password>')
    expect(masked).toContain('<Username>admin</Username>')
  })

  it('redacts Pin and Puk tag contents', () => {
    const xml = '<request><Pin>1234</Pin><Puk>87654321</Puk></request>'
    const masked = maskHiLinkSecrets(xml)

    expect(masked).not.toMatch(/1234|87654321/)
    expect(masked).toContain('<Pin>[REDACTED]</Pin>')
    expect(masked).toContain('<Puk>[REDACTED]</Puk>')
  })

  it('does NOT mask SMS Content -- messaging is the device purpose', () => {
    const xml = '<request><Phone>+37499</Phone><Content>your code is 1234</Content></request>'
    const masked = maskHiLinkSecrets(xml)

    expect(masked).toContain('<Content>your code is 1234</Content>')
    expect(masked).toContain('<Phone>+37499</Phone>')
  })

  it('does NOT mask a Username tag', () => {
    const xml = '<request><Username>admin</Username></request>'
    expect(maskHiLinkSecrets(xml)).toBe(xml)
  })

  it('leaves a body with no secrets unchanged', () => {
    const xml = '<request><signal>4</signal><mode>LTE</mode></request>'
    expect(maskHiLinkSecrets(xml)).toBe(xml)
  })
})
