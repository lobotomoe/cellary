import { describe, expect, it } from 'vitest'
import {
  classifyUsbDevice,
  findModemEntry,
  findProductConfig,
  USB_MODEM_DATABASE,
} from '../../src/discovery/usb-ids.js'
import type { UsbInterfaceInfo } from '../../src/discovery/usb-types.js'

describe('usb-ids', () => {
  describe('findModemEntry()', () => {
    it('finds Huawei by storage-mode PID', () => {
      const entry = findModemEntry(0x12d1, 0x14fe)
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Huawei')
      expect(entry?.vendor).toBe(0x12d1)
    })

    it('finds Huawei by modem-mode PID', () => {
      const entry = findModemEntry(0x12d1, 0x1506)
      expect(entry).toBeDefined()
      expect(entry?.name).toBe('Huawei')
    })

    it('returns undefined for unknown vendor', () => {
      const entry = findModemEntry(0xffff, 0x0001)
      expect(entry).toBeUndefined()
    })

    it('returns undefined for known vendor but unknown product', () => {
      const entry = findModemEntry(0x12d1, 0x9999)
      expect(entry).toBeUndefined()
    })

    it('all storage PIDs are resolvable', () => {
      for (const entry of USB_MODEM_DATABASE) {
        for (const pid of entry.storageProducts) {
          const found = findModemEntry(entry.vendor, pid)
          expect(found).toBe(entry)
        }
      }
    })

    it('all modem PIDs are resolvable', () => {
      for (const entry of USB_MODEM_DATABASE) {
        for (const product of entry.modemProducts) {
          const found = findModemEntry(entry.vendor, product.productId)
          expect(found).toBe(entry)
        }
      }
    })
  })

  describe('findProductConfig()', () => {
    it('returns USB transport with correct AT interface for E3372 (PID 0x1506)', () => {
      const entry = findModemEntry(0x12d1, 0x1506)
      expect(entry).toBeDefined()
      if (!entry) return

      const config = findProductConfig(entry, 0x1506)
      expect(config).toBeDefined()
      expect(config?.transport).toMatchObject({ type: 'usb', atInterface: 0 })
    })

    it('returns USB transport with correct AT interface for E8372 (PID 0x1566)', () => {
      const entry = findModemEntry(0x12d1, 0x1566)
      expect(entry).toBeDefined()
      if (!entry) return

      const config = findProductConfig(entry, 0x1566)
      expect(config).toBeDefined()
      expect(config?.transport).toMatchObject({ type: 'usb', atInterface: 2 })
    })

    it('returns HiLink transport for E8372h (PID 0x14db)', () => {
      const entry = findModemEntry(0x12d1, 0x14db)
      expect(entry).toBeDefined()
      if (!entry) return

      const config = findProductConfig(entry, 0x14db)
      expect(config?.transport).toMatchObject({
        type: 'http',
        defaultUrl: 'http://192.168.8.1',
      })
    })

    it('returns E173 model and AT interface 2 for PID 0x1C05 (Qualcomm)', () => {
      const entry = findModemEntry(0x12d1, 0x1c05)
      expect(entry).toBeDefined()
      if (!entry) return

      const config = findProductConfig(entry, 0x1c05)
      expect(config?.transport).toMatchObject({ type: 'usb', atInterface: 2 })
      expect(config?.model?.name).toBe('Huawei E173')
    })

    it('returns undefined for unknown product ID', () => {
      const entry = USB_MODEM_DATABASE[0]
      if (!entry) return

      const config = findProductConfig(entry, 0x9999)
      expect(config).toBeUndefined()
    })
  })

  describe('USB_MODEM_DATABASE', () => {
    it('has Huawei entry with vendor control and SCSI switch methods', () => {
      const huawei = USB_MODEM_DATABASE.find((e) => e.vendor === 0x12d1)
      expect(huawei).toBeDefined()
      if (huawei === undefined) return
      const methods = Array.isArray(huawei.switchMethod)
        ? huawei.switchMethod
        : [huawei.switchMethod]
      const vendorControl = methods.find((m) => m.type === 'vendor-control')
      expect(vendorControl).toBeDefined()
      if (vendorControl?.type === 'vendor-control') {
        expect(vendorControl.requestType).toBe(0x40)
        expect(vendorControl.request).toBe(0xa1)
      }
      expect(methods.some((m) => m.type === 'scsi-cbw')).toBe(true)
    })

    it('every entry has a profile', () => {
      for (const entry of USB_MODEM_DATABASE) {
        expect(entry.profile).toBeDefined()
        expect(entry.profile.name).toBeTruthy()
      }
    })

    it('every modem product has a declared transport', () => {
      for (const entry of USB_MODEM_DATABASE) {
        for (const product of entry.modemProducts) {
          expect(product.transport).toBeDefined()
          expect(product.transport.type).toMatch(/^(usb|http|serial)$/)
        }
      }
    })
  })

  describe('classifyUsbDevice()', () => {
    const HUAWEI = 0x12d1
    const PID_1C05 = 0x1c05

    /** Helper: build a minimal UsbInterfaceInfo[][] from class values. */
    function makeInterfaces(...classes: number[]): UsbInterfaceInfo[][] {
      return classes.map((cls) => [
        { bInterfaceClass: cls, bInterfaceSubClass: 0, bInterfaceProtocol: 0 },
      ])
    }

    it('classifies PID 0x1C05 as modem-usb with 7+ interfaces including CDC', () => {
      // Normal modem mode: 7 interfaces, one is USB_CLASS_COMM (0x02)
      const interfaces = makeInterfaces(0x02, 0x0a, 0xff, 0xff, 0xff, 0xff, 0xff)
      const result = classifyUsbDevice(HUAWEI, PID_1C05, 1, [1], interfaces)
      expect(result).toBeDefined()
      expect(result?.mode).toBe('modem-usb')
    })

    it('classifies PID 0x1C05 as modem-usb with 3 interfaces (E173, not download)', () => {
      // 0x1C05 is shared: E173 modem mode (3 serial ports) vs Balong HDLC
      // download mode. There is no reliable single-probe discriminator, so it
      // is resolved in favour of a working modem -- always modem-usb here.
      const interfaces = makeInterfaces(0xff, 0xff, 0xff)
      const result = classifyUsbDevice(HUAWEI, PID_1C05, 1, [1], interfaces)
      expect(result).toBeDefined()
      expect(result?.mode).toBe('modem-usb')
    })

    it('falls back to modem-usb when interface descriptors are unavailable', () => {
      // No interface info (e.g. insufficient privileges on macOS)
      const result = classifyUsbDevice(HUAWEI, PID_1C05, 1, [1], undefined)
      expect(result).toBeDefined()
      expect(result?.mode).toBe('modem-usb')
    })

    it('classifies BootROM PID as emergency', () => {
      const result = classifyUsbDevice(HUAWEI, 0x1443, 1, [1])
      expect(result).toBeDefined()
      expect(result?.mode).toBe('emergency')
    })

    it('classifies storage PID as storage', () => {
      const result = classifyUsbDevice(HUAWEI, 0x14fe, 1, [1])
      expect(result).toBeDefined()
      expect(result?.mode).toBe('storage')
    })

    it('returns undefined for unknown device', () => {
      const result = classifyUsbDevice(0xffff, 0x0001, 1, [1])
      expect(result).toBeUndefined()
    })
  })
})
