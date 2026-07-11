import { describe, expect, it } from 'vitest'
import { createProbe, detectState } from '../../src/lifecycle/detector.js'
import { GENERIC_DETECTORS } from '../../src/lifecycle/generic-detectors.js'
import { GENERIC_LAYER } from '../../src/lifecycle/generic-states.js'
import { HUAWEI_LAYER } from '../../src/vendor/huawei/lifecycle.js'
import { HUAWEI_DETECTORS } from '../../src/vendor/huawei/lifecycle-detectors.js'
import { BALONG_LAYER } from '../../src/vendor/huawei/platforms/balong/lifecycle.js'
import { E3372_LAYER } from '../../src/vendor/huawei/platforms/balong/models/e3372/lifecycle.js'
import { E8372_LAYER } from '../../src/vendor/huawei/platforms/balong/models/e8372/lifecycle.js'
import { QUALCOMM_LAYER } from '../../src/vendor/huawei/platforms/qualcomm/lifecycle.js'

const HUAWEI_VID = 0x12d1
const LAYERS = [GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, E8372_LAYER, E3372_LAYER, QUALCOMM_LAYER]
const ALL_DETECTORS = [...GENERIC_DETECTORS, ...HUAWEI_DETECTORS]

describe('detectState()', () => {
  describe('generic detectors (classified)', () => {
    it('detects absent when device is not present', async () => {
      const probe = createProbe({ vendorId: HUAWEI_VID, productId: 0, present: false })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('absent')
      expect(result?.confidence).toBe('classified')
    })

    it('detects storage mode', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x14fe,
        present: true,
        mode: 'storage',
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('storage')
      expect(result?.confidence).toBe('classified')
    })

    it('detects modem mode (USB)', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1506,
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('modem')
      expect(result?.confidence).toBe('classified')
    })

    it('detects modem mode (HTTP)', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x14db,
        present: true,
        mode: 'http',
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('modem')
    })

    it('detects download mode', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1c05,
        present: true,
        mode: 'download',
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('download')
    })

    it('detects emergency mode', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1443,
        present: true,
        mode: 'emergency',
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('emergency')
    })
  })

  describe('fallback probe detectors (observed)', () => {
    it('detects modem via CDC ACM interface when mode is undefined', async () => {
      const probe = createProbe({
        vendorId: 0x9999,
        productId: 0x1234,
        present: true,
        // mode is undefined — PID not in database
        interfaces: [
          { bInterfaceClass: 0x02, bInterfaceSubClass: 0x02, bInterfaceProtocol: 0 }, // CDC ACM
          { bInterfaceClass: 0x0a, bInterfaceSubClass: 0, bInterfaceProtocol: 0 }, // CDC Data
        ],
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('modem')
      expect(result?.confidence).toBe('observed')
    })

    it('detects storage via Mass Storage interface when mode is undefined', async () => {
      const probe = createProbe({
        vendorId: 0x9999,
        productId: 0x1234,
        present: true,
        interfaces: [
          { bInterfaceClass: 0x08, bInterfaceSubClass: 0x06, bInterfaceProtocol: 0x50 }, // Mass Storage
        ],
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('storage')
      expect(result?.confidence).toBe('observed')
    })

    it('does not trigger fallback when mode is already set', async () => {
      const probe = createProbe({
        vendorId: 0x9999,
        productId: 0x1234,
        present: true,
        mode: 'modem-usb',
        interfaces: [{ bInterfaceClass: 0x02, bInterfaceSubClass: 0x02, bInterfaceProtocol: 0 }],
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result?.stateId).toBe('modem')
      expect(result?.confidence).toBe('classified') // mode-based, not fallback
    })

    it('returns undefined for unknown device with no recognizable interfaces', async () => {
      const probe = createProbe({
        vendorId: 0x9999,
        productId: 0x1234,
        present: true,
        interfaces: [
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 }, // Vendor-specific
        ],
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result).toBeUndefined()
    })

    it('returns undefined for unknown device with no interfaces', async () => {
      const probe = createProbe({
        vendorId: 0x9999,
        productId: 0x1234,
        present: true,
      })
      const result = await detectState(probe, GENERIC_DETECTORS, [GENERIC_LAYER])
      expect(result).toBeUndefined()
    })
  })

  describe('Huawei detectors (identified, override generic)', () => {
    it('detects hilink_at for E8372 PID 0x1566', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1566,
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('hilink_at')
      expect(result?.confidence).toBe('identified')
    })

    it('detects hilink_only for E8372 PID 0x14db', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x14db,
        present: true,
        mode: 'http',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('hilink_only')
      expect(result?.confidence).toBe('identified')
    })

    it('detects stick for E3372 PID 0x1506', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1506,
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('stick')
    })

    it('detects stick for E3372 HiLink PID 0x14dc', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x14dc,
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('stick')
    })

    it('detects balong_download when mode is download', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1c05,
        present: true,
        mode: 'download',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('balong_download')
    })

    it('detects stick (E173) for PID 0x1C05 with few interfaces', async () => {
      // 0x1C05 with fewer than 4 interfaces is the Qualcomm E173's 3-port modem
      // mode, not Balong download. The ambiguity is resolved toward a working
      // modem -- see qualcomm/lifecycle-detectors.ts.
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1c05,
        present: true,
        interfaces: [
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
          { bInterfaceClass: 0x08, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
        ],
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('stick')
    })

    it('detects stick (E173) for PID 0x1C05 in modem-usb mode, over generic modem', async () => {
      // A real E173 classifies as modem-usb. The Qualcomm platform detector must
      // outrank the generic 'modem' detector so navigation lands on the usable
      // terminal 'stick' state directly rather than the generic intermediate.
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1c05,
        present: true,
        mode: 'modem-usb',
        interfaces: [
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
          { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
        ],
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('stick')
    })

    it('detects stick for PID 0x1C05 with many interfaces and CDC class', async () => {
      const interfaces = [
        { bInterfaceClass: 0x02, bInterfaceSubClass: 0, bInterfaceProtocol: 0 }, // CDC
        { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
        { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
        { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
        { bInterfaceClass: 0xff, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
      ]
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1c05,
        present: true,
        interfaces,
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('stick')
    })

    it('falls back to generic storage for Huawei storage PID', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x14fe,
        present: true,
        mode: 'storage',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('storage')
    })

    it('does not match Huawei detectors for non-Huawei vendor', async () => {
      const probe = createProbe({
        vendorId: 0x2c7c, // Quectel
        productId: 0x1566, // Same PID as E8372, different vendor
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('modem') // Generic, not hilink_at
    })
  })

  describe('layer priority ordering', () => {
    it('Huawei detectors take priority over generic', async () => {
      const probe = createProbe({
        vendorId: HUAWEI_VID,
        productId: 0x1566,
        present: true,
        mode: 'modem-usb',
      })
      const result = await detectState(probe, ALL_DETECTORS, LAYERS)
      expect(result?.stateId).toBe('hilink_at')
    })
  })
})
