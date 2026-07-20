import { describe, expect, it } from 'vitest'

import { DeviceLeasedError, LeaseRegistry } from '../src/lease-registry.js'

const DEVICE = '12d1:1-2'
const OTHER_DEVICE = '19d2:1-3'
const CLIENT_A = 'client-a'
const CLIENT_B = 'client-b'

describe('LeaseRegistry', () => {
  describe('claim', () => {
    it('grants a free device to the claiming client', () => {
      const leases = new LeaseRegistry()
      const info = leases.claim(DEVICE, CLIENT_A)

      expect(info.deviceId).toBe(DEVICE)
      expect(info.expiresAt).toBeUndefined()
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
    })

    it('rejects a device already held by another client', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)

      expect(() => leases.claim(DEVICE, CLIENT_B)).toThrow(DeviceLeasedError)
      // The holder is unchanged after a rejected claim.
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
    })

    it('reports who holds the device on rejection', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)

      try {
        leases.claim(DEVICE, CLIENT_B)
        expect.unreachable('claim should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DeviceLeasedError)
        if (err instanceof DeviceLeasedError) {
          expect(err.heldBy).toBe(CLIENT_A)
        }
      }
    })

    it('is idempotent for the current holder', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)
      expect(() => leases.claim(DEVICE, CLIENT_A)).not.toThrow()
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
    })
  })

  describe('assertHolder', () => {
    it('passes for a free device', () => {
      const leases = new LeaseRegistry()
      expect(() => leases.assertHolder(DEVICE, CLIENT_A)).not.toThrow()
    })

    it('passes for the holder and throws for anyone else', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)

      expect(() => leases.assertHolder(DEVICE, CLIENT_A)).not.toThrow()
      expect(() => leases.assertHolder(DEVICE, CLIENT_B)).toThrow(DeviceLeasedError)
    })
  })

  describe('release', () => {
    it('frees a device held by the client', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)
      leases.release(DEVICE, CLIENT_A)

      expect(leases.holder(DEVICE)).toBeUndefined()
      // Now another client can take it.
      expect(() => leases.claim(DEVICE, CLIENT_B)).not.toThrow()
    })

    it('is a no-op for an unheld device', () => {
      const leases = new LeaseRegistry()
      expect(() => leases.release(DEVICE, CLIENT_A)).not.toThrow()
    })

    it("throws when releasing another client's lease", () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)
      expect(() => leases.release(DEVICE, CLIENT_B)).toThrow(DeviceLeasedError)
      // A's lease is untouched.
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
    })
  })

  describe('releaseAllForClient', () => {
    it('drops every lease held by the client, leaving others intact', () => {
      const leases = new LeaseRegistry()
      leases.claim(DEVICE, CLIENT_A)
      leases.claim(OTHER_DEVICE, CLIENT_B)

      leases.releaseAllForClient(CLIENT_A)

      expect(leases.holder(DEVICE)).toBeUndefined()
      expect(leases.holder(OTHER_DEVICE)).toBe(CLIENT_B)
    })
  })

  describe('ttl expiry', () => {
    it('treats an expired lease as free', () => {
      let now = 1_000
      const leases = new LeaseRegistry(() => now)
      leases.claim(DEVICE, CLIENT_A, 5_000)

      // Still within the TTL: held.
      now = 5_999
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
      expect(() => leases.assertHolder(DEVICE, CLIENT_B)).toThrow(DeviceLeasedError)

      // Past the TTL: the lease lapses and another client can claim it.
      now = 6_001
      expect(leases.holder(DEVICE)).toBeUndefined()
      expect(() => leases.claim(DEVICE, CLIENT_B)).not.toThrow()
      expect(leases.holder(DEVICE)).toBe(CLIENT_B)
    })

    it('re-claiming by the holder refreshes the expiry', () => {
      let now = 0
      const leases = new LeaseRegistry(() => now)
      leases.claim(DEVICE, CLIENT_A, 1_000)

      now = 900
      leases.claim(DEVICE, CLIENT_A, 1_000) // refresh: new expiry at 1900

      now = 1_500
      expect(leases.holder(DEVICE)).toBe(CLIENT_A)
    })
  })
})
