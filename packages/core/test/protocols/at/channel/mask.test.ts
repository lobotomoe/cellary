import { describe, expect, it } from 'vitest'

import { maskAtSecrets } from '../../../../src/protocols/at/channel/mask.js'

describe('maskAtSecrets', () => {
  it('redacts a SIM PIN', () => {
    expect(maskAtSecrets('AT+CPIN="1234"')).toBe('AT+CPIN=[REDACTED]')
    expect(maskAtSecrets('AT+CPIN=1234')).toBe('AT+CPIN=[REDACTED]')
  })

  it('redacts a PUK + new PIN pair', () => {
    expect(maskAtSecrets('AT+CPIN="12345678","0000"')).toBe('AT+CPIN=[REDACTED]')
  })

  it('redacts PIN2, password change, and facility lock', () => {
    expect(maskAtSecrets('AT+CPIN2="1234"')).toBe('AT+CPIN2=[REDACTED]')
    expect(maskAtSecrets('AT+CPWD="SC","0000","1234"')).toBe('AT+CPWD=[REDACTED]')
    expect(maskAtSecrets('AT+CLCK="SC",1,"1234"')).toBe('AT+CLCK=[REDACTED]')
    expect(maskAtSecrets('AT+CACM="1234"')).toBe('AT+CACM=[REDACTED]')
  })

  it('redacts a vendor unlock code', () => {
    expect(maskAtSecrets('AT^DATALOCK="87654321"')).toBe('AT^DATALOCK=[REDACTED]')
  })

  it('redacts the echo of a credential command (ATE1 replays it as an RX line)', () => {
    // With echo on, the PIN comes back on the RX path too -- must be masked there.
    expect(maskAtSecrets('AT+CPIN="4321"')).toBe('AT+CPIN=[REDACTED]')
  })

  it('preserves case of the command name', () => {
    expect(maskAtSecrets('at+cpin="1234"')).toBe('at+cpin=[REDACTED]')
  })

  it('leaves queries and status responses intact (no value to redact)', () => {
    expect(maskAtSecrets('AT+CPIN?')).toBe('AT+CPIN?')
    expect(maskAtSecrets('+CPIN: READY')).toBe('+CPIN: READY')
    expect(maskAtSecrets('+CPIN: SIM PIN')).toBe('+CPIN: SIM PIN')
  })

  it('does not touch non-credential commands (incl. SMS payloads)', () => {
    expect(maskAtSecrets('AT+CSQ')).toBe('AT+CSQ')
    expect(maskAtSecrets('AT+CMGS=23')).toBe('AT+CMGS=23')
    expect(maskAtSecrets('AT+CPINR')).toBe('AT+CPINR')
    expect(maskAtSecrets('+CPINR: SIM PIN,3,10')).toBe('+CPINR: SIM PIN,3,10')
  })
})
