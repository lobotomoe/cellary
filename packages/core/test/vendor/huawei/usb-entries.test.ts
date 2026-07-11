import { describe, expect, it } from 'vitest'
import { findProductConfig, isModemProduct } from '../../../src/discovery/usb-ids.js'
import { huaweiUsbEntry } from '../../../src/vendor/huawei/usb-entries.js'

describe('huaweiUsbEntry resolver integration', () => {
  describe('resolveUnknownProduct', () => {
    it('resolves a kext-known PID not in static modemProducts', () => {
      // 0x1404 is in the kext database (pcui=2, ecm=5) but not in static modemProducts
      const config = huaweiUsbEntry.resolveUnknownProduct?.(0x1404)
      expect(config).toBeDefined()
      expect(config?.productId).toBe(0x1404)
      expect(config?.transport).toEqual({ type: 'usb', atInterface: 2 })
    })

    it('returns undefined for unknown PID', () => {
      const config = huaweiUsbEntry.resolveUnknownProduct?.(0x9999)
      expect(config).toBeUndefined()
    })

    it('returns undefined for PID without PCUI interface', () => {
      // A PID that has no PCUI entry should not be resolvable as AT modem
      // Storage PIDs and ECM-only PIDs fall into this category
      const config = huaweiUsbEntry.resolveUnknownProduct?.(0x12d1)
      expect(config).toBeUndefined()
    })
  })

  describe('findProductConfig with resolver fallback', () => {
    it('prefers static entry over resolver', () => {
      // 0x1506 (E3372 stick) is in static modemProducts
      const config = findProductConfig(huaweiUsbEntry, 0x1506)
      expect(config).toBeDefined()
      expect(config?.productId).toBe(0x1506)
      expect(config?.transport).toEqual({ type: 'usb', atInterface: 0 })
    })

    it('falls back to resolver for kext-only PID', () => {
      const config = findProductConfig(huaweiUsbEntry, 0x1407)
      expect(config).toBeDefined()
      expect(config?.productId).toBe(0x1407)
      expect(config?.transport).toEqual({ type: 'usb', atInterface: 1 })
    })
  })

  describe('isModemProduct', () => {
    it('returns true for static modem PID', () => {
      expect(isModemProduct(huaweiUsbEntry, 0x1506)).toBe(true)
    })

    it('returns true for kext-resolved PID', () => {
      expect(isModemProduct(huaweiUsbEntry, 0x1404)).toBe(true)
    })

    it('returns false for storage PID', () => {
      expect(isModemProduct(huaweiUsbEntry, 0x1f01)).toBe(false)
    })

    it('returns false for unknown PID', () => {
      expect(isModemProduct(huaweiUsbEntry, 0x9999)).toBe(false)
    })
  })
})
