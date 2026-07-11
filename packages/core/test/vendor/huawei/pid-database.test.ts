import { describe, expect, it } from 'vitest'

import {
  HUAWEI_PID_COUNT,
  hasEcmCapability,
  isKnownHuaweiModemPid,
  lookupHuaweiPid,
} from '../../../src/vendor/huawei/pid-database.js'

describe('pid-database', () => {
  describe('lookupHuaweiPid', () => {
    it('returns PCUI interface for known AT-only PID', () => {
      const info = lookupHuaweiPid(0x1001)
      expect(info).toBeDefined()
      expect(info?.pcui).toBe(2)
      expect(info?.ecm).toBeUndefined()
    })

    it('returns both PCUI and ECM for HiLink combo PID', () => {
      const info = lookupHuaweiPid(0x1404)
      expect(info).toBeDefined()
      expect(info?.pcui).toBe(2)
      expect(info?.ecm).toBe(5)
    })

    it('returns undefined for unknown PID', () => {
      expect(lookupHuaweiPid(0x9999)).toBeUndefined()
    })

    it('returns undefined for vendor ID used as PID', () => {
      expect(lookupHuaweiPid(0x12d1)).toBeUndefined()
    })
  })

  describe('isKnownHuaweiModemPid', () => {
    it('returns true for known PID', () => {
      expect(isKnownHuaweiModemPid(0x1506)).toBe(true)
    })

    it('returns false for unknown PID', () => {
      expect(isKnownHuaweiModemPid(0xffff)).toBe(false)
    })
  })

  describe('hasEcmCapability', () => {
    it('returns true for PID with ECM interface', () => {
      expect(hasEcmCapability(0x1404)).toBe(true)
    })

    it('returns false for AT-only PID', () => {
      expect(hasEcmCapability(0x1506)).toBe(false)
    })

    it('returns false for unknown PID', () => {
      expect(hasEcmCapability(0x9999)).toBe(false)
    })
  })

  describe('HUAWEI_PID_COUNT', () => {
    it('has a reasonable number of entries', () => {
      // Kext contains 170+ PIDs; our database has a subset with known interface roles
      expect(HUAWEI_PID_COUNT).toBeGreaterThan(100)
    })
  })
})
