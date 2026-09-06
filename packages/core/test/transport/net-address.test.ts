import { describe, expect, it } from 'vitest'

import { TransportError } from '../../src/errors.js'
import { deriveLocalMac, isIpv4Cidr, parseIpv4Cidr } from '../../src/transport/net-address.js'

describe('parseIpv4Cidr', () => {
  it('accepts a well-formed address with prefix length', () => {
    expect(parseIpv4Cidr('192.168.100.2/24')).toBe('192.168.100.2/24')
    expect(isIpv4Cidr('0.0.0.0/0')).toBe(true)
    expect(isIpv4Cidr('255.255.255.255/32')).toBe(true)
  })

  it('rejects malformed input instead of passing it to the stack', () => {
    for (const bad of ['192.168.100.2', '192.168.100/24', '256.1.1.1/24', '1.1.1.1/33', 'abc']) {
      expect(isIpv4Cidr(bad)).toBe(false)
      expect(() => parseIpv4Cidr(bad)).toThrow(TransportError)
    }
  })
})

describe('deriveLocalMac', () => {
  it('sets the locally-administered bit, clears multicast, and bumps the last octet', () => {
    expect(deriveLocalMac('00:1a:2b:3c:4d:5e')).toBe('02:1a:2b:3c:4d:5f')
  })

  it('wraps the last octet and keeps the result unicast', () => {
    expect(deriveLocalMac('01:00:00:00:00:ff')).toBe('02:00:00:00:00:00')
  })

  it('rejects a MAC that is not six octets', () => {
    expect(() => deriveLocalMac('00:11:22')).toThrow(TransportError)
  })
})
