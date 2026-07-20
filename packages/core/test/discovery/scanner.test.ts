import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock USB module ─────────────────────────────────────────────────────────

const { mockGetDeviceList, mockFindByIds } = vi.hoisted(() => ({
  mockGetDeviceList: vi.fn(() => [] as unknown[]),
  mockFindByIds: vi.fn(() => undefined as unknown),
}))

vi.mock('usb', () => ({
  getDeviceList: mockGetDeviceList,
  findByIds: mockFindByIds,
}))

// ── Mock HiLink module ──────────────────────────────────────────────────────

const { mockRequestHiLinkModeSwitch } = vi.hoisted(() => ({
  mockRequestHiLinkModeSwitch: vi.fn(async () => {}),
}))

vi.mock('../../src/vendor/huawei/protocols/hilink/index.js', () => ({
  requestHiLinkModeSwitch: mockRequestHiLinkModeSwitch,
  HILINK_DRIVER: { kind: 'vendor', api: 'hilink' },
}))

// ── Mock modeswitch module ──────────────────────────────────────────────────

const { mockSwitchDevice, mockWaitForDevice } = vi.hoisted(() => ({
  mockSwitchDevice: vi.fn(async () => ({
    switched: false as boolean,
    newProductId: undefined as number | undefined,
  })),
  mockWaitForDevice: vi.fn(async () => undefined as number | undefined),
}))

vi.mock('../../src/discovery/modeswitch.js', () => ({
  switchDevice: mockSwitchDevice,
  waitForDevice: mockWaitForDevice,
}))

// ── Mock serialport module ──────────────────────────────────────────────────

const { mockSerialPortList } = vi.hoisted(() => ({
  mockSerialPortList: vi.fn(async () => [] as unknown[]),
}))

vi.mock('serialport', () => ({
  SerialPort: { list: mockSerialPortList },
}))

import { provision } from '../../src/discovery/provisioner.js'
import { discover, scanUsb } from '../../src/discovery/scanner.js'
import { USB_MODEM_DATABASE } from '../../src/discovery/usb-ids.js'
import type { DiscoveredModem } from '../../src/discovery/usb-types.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MockInterfaceDescriptor {
  bInterfaceClass: number
  bInterfaceSubClass: number
  bInterfaceProtocol: number
}

function createMockDevice(
  vendorId: number,
  productId: number,
  interfaces?: MockInterfaceDescriptor[][],
  location?: { busNumber: number; portNumbers: number[] },
) {
  return {
    deviceDescriptor: { idVendor: vendorId, idProduct: productId },
    busNumber: location?.busNumber ?? 1,
    portNumbers: location?.portNumbers ?? [1],
    configDescriptor: interfaces
      ? { interfaces: interfaces.map((alts) => alts.map((alt) => ({ ...alt }))) }
      : undefined,
    interfaces: undefined,
    open: vi.fn(),
    close: vi.fn(),
    interface: vi.fn(),
  }
}

function createMockPort(overrides: {
  path: string
  serialNumber?: string | undefined
  vendorId?: string
  productId?: string
}) {
  return {
    path: overrides.path,
    manufacturer: 'Huawei',
    serialNumber: overrides.serialNumber,
    pnpId: undefined,
    locationId: undefined,
    vendorId: overrides.vendorId ?? '12d1',
    productId: overrides.productId ?? '1506',
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('scanner', () => {
  beforeEach(() => {
    mockGetDeviceList.mockReset().mockReturnValue([])
    mockFindByIds.mockReset().mockReturnValue(undefined)
    mockRequestHiLinkModeSwitch.mockReset().mockResolvedValue(undefined)
    mockSwitchDevice.mockReset().mockResolvedValue({ switched: false, newProductId: undefined })
    mockWaitForDevice.mockReset().mockResolvedValue(undefined)
    mockSerialPortList.mockReset().mockResolvedValue([])
  })

  describe('scanUsb()', () => {
    it('finds Huawei device in storage mode', () => {
      const device = createMockDevice(0x12d1, 0x14fe)
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(1)
      expect(result[0]?.name).toBe('Huawei')
      expect(result[0]?.mode).toBe('storage')
    })

    it('finds Huawei E3372 in modem mode (USB direct)', () => {
      const device = createMockDevice(0x12d1, 0x1506)
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(1)
      expect(result[0]?.mode).toBe('modem-usb')
    })

    it('finds Huawei E8372h in HTTP mode', () => {
      const device = createMockDevice(0x12d1, 0x14db)
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(1)
      expect(result[0]?.mode).toBe('http')
      if (result[0]?.mode === 'http') {
        expect(result[0].url).toBe('http://192.168.8.1')
      }
    })

    it('returns empty array for unknown devices without interface descriptors', () => {
      const device = createMockDevice(0xffff, 0x0001)
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(0)
    })

    it('discovers unknown CDC ACM device as modem-usb with entry: undefined', () => {
      const cdcAcmInterface = [
        { bInterfaceClass: 0x02, bInterfaceSubClass: 0x02, bInterfaceProtocol: 0x01 },
      ]
      const device = createMockDevice(0xaaaa, 0xbbbb, [cdcAcmInterface])
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(1)
      expect(result[0]?.mode).toBe('modem-usb')
      expect(result[0]?.entry).toBeUndefined()
      expect(result[0]?.name).toContain('0xaaaa')
      expect(result[0]?.name).toContain('0xbbbb')
    })

    it('does not discover CDC ECM-only devices (Ethernet adapters)', () => {
      // CDC ECM (subclass 0x06) is Ethernet, not modem
      const cdcEcmInterface = [
        { bInterfaceClass: 0x02, bInterfaceSubClass: 0x06, bInterfaceProtocol: 0x00 },
      ]
      const device = createMockDevice(0xaaaa, 0xcccc, [cdcEcmInterface])
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(0)
    })

    it('does not apply CDC ACM fallback for known database devices', () => {
      // Huawei in storage mode — should use database classification, not CDC ACM fallback
      const cdcAcmInterface = [
        { bInterfaceClass: 0x02, bInterfaceSubClass: 0x02, bInterfaceProtocol: 0x01 },
      ]
      const device = createMockDevice(0x12d1, 0x14fe, [cdcAcmInterface])
      mockGetDeviceList.mockReturnValue([device])

      const result = scanUsb()

      expect(result).toHaveLength(1)
      expect(result[0]?.mode).toBe('storage')
      expect(result[0]?.entry).toBeDefined()
    })

    it('returns empty array when no USB devices', () => {
      mockGetDeviceList.mockReturnValue([])

      const result = scanUsb()

      expect(result).toHaveLength(0)
    })

    it('finds multiple devices', () => {
      const storage = createMockDevice(0x12d1, 0x14fe)
      const modem = createMockDevice(0x12d1, 0x1506)
      const unknown = createMockDevice(0x1234, 0x5678)
      mockGetDeviceList.mockReturnValue([storage, modem, unknown])

      const result = scanUsb()

      expect(result).toHaveLength(2)
      expect(result[0]?.mode).toBe('storage')
      expect(result[1]?.mode).toBe('modem-usb')
    })
  })

  describe('provision()', () => {
    it('throws DiscoveryError when no devices found', async () => {
      mockGetDeviceList.mockReturnValue([])

      await expect(provision()).rejects.toThrow('No supported modem found')
    })

    it('returns USB transport for modem-mode device (fixed interface)', async () => {
      const device = createMockDevice(0x12d1, 0x1506)
      mockGetDeviceList.mockReturnValue([device])

      const result = await provision()

      expect(result.transport).toMatchObject({
        type: 'usb',
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 0,
      })
      expect(result.driver).toEqual({ kind: 'at' })
      expect(result.profile.name).toBe('Huawei')
    })

    it('returns vendor HTTP transport for E8372h in HiLink-only mode (no AT switch)', async () => {
      // E8372_PID_HILINK_ONLY (0x14db) has no AT USB interface -- provision() must use HiLink API
      // directly rather than attempting mode switch.
      const huaweiEntry = USB_MODEM_DATABASE.find((e) => e.vendor === 0x12d1)
      if (huaweiEntry === undefined) throw new Error('expected Huawei entry in USB_MODEM_DATABASE')
      const httpModem: DiscoveredModem = {
        mode: 'http',
        vendorId: 0x12d1,
        productId: 0x14db,
        name: 'Huawei',
        deviceId: '12d1:1-2',
        entry: huaweiEntry,
        busNumber: 1,
        portNumbers: [2],
        url: 'http://192.168.8.1',
      }

      const result = await provision(httpModem)

      expect(result.transport).toMatchObject({ type: 'http', url: 'http://192.168.8.1' })
      expect(result.driver).toEqual({ kind: 'vendor', api: 'hilink' })
      expect(mockRequestHiLinkModeSwitch).not.toHaveBeenCalled()
      expect(mockSwitchDevice).not.toHaveBeenCalled()
    })
  })

  describe('discover() device identity', () => {
    it('keeps two identical modems distinct by serial number', async () => {
      mockSerialPortList.mockResolvedValue([
        createMockPort({ path: '/dev/ttyUSB0', serialNumber: 'AAAA' }),
        createMockPort({ path: '/dev/ttyUSB3', serialNumber: 'BBBB' }),
      ])

      const result = await discover()

      const serialEntries = result.filter((m) => m.mode === 'serial')
      expect(serialEntries).toHaveLength(2)
      expect(new Set(serialEntries.map((m) => m.deviceId))).toEqual(
        new Set(['serial:/dev/ttyUSB0', 'serial:/dev/ttyUSB3']),
      )
    })

    it('collapses one modem exposing several ports (same serial) to one entry', async () => {
      mockSerialPortList.mockResolvedValue([
        createMockPort({ path: '/dev/ttyUSB0', serialNumber: 'AAAA' }),
        createMockPort({ path: '/dev/ttyUSB1', serialNumber: 'AAAA' }),
        createMockPort({ path: '/dev/ttyUSB2', serialNumber: 'AAAA' }),
      ])

      const result = await discover()

      expect(result.filter((m) => m.mode === 'serial')).toHaveLength(1)
      // Lowest sorted path wins (conventionally the AT command port).
      expect(result[0]?.deviceId).toBe('serial:/dev/ttyUSB0')
    })

    it('falls back to VID:PID collapse when ports report no serial number', async () => {
      mockSerialPortList.mockResolvedValue([
        createMockPort({ path: '/dev/ttyUSB0', serialNumber: undefined }),
        createMockPort({ path: '/dev/ttyUSB1', serialNumber: undefined }),
      ])

      const result = await discover()

      expect(result.filter((m) => m.mode === 'serial')).toHaveLength(1)
    })

    it('drops only a USB entry paired with a serial twin, never a distinct device', async () => {
      // One modem in serial mode + two identical modems visible via libusb.
      mockSerialPortList.mockResolvedValue([
        createMockPort({ path: '/dev/ttyUSB0', serialNumber: 'AAAA' }),
      ])
      mockGetDeviceList.mockReturnValue([
        createMockDevice(0x12d1, 0x1506, undefined, { busNumber: 1, portNumbers: [1] }),
        createMockDevice(0x12d1, 0x1506, undefined, { busNumber: 1, portNumbers: [2] }),
      ])

      const result = await discover()

      // 1 serial + (2 usb - 1 twin) = 2 devices total. Neither USB device is hidden
      // beyond the single serial twin.
      expect(result).toHaveLength(2)
      expect(result.filter((m) => m.mode === 'serial')).toHaveLength(1)
      expect(result.filter((m) => m.mode === 'modem-usb')).toHaveLength(1)
    })

    it('prefers serial and drops the USB view of a single device seen in both', async () => {
      mockSerialPortList.mockResolvedValue([
        createMockPort({ path: '/dev/ttyUSB0', serialNumber: 'AAAA' }),
      ])
      mockGetDeviceList.mockReturnValue([
        createMockDevice(0x12d1, 0x1506, undefined, { busNumber: 1, portNumbers: [1] }),
      ])

      const result = await discover()

      expect(result).toHaveLength(1)
      expect(result[0]?.mode).toBe('serial')
    })
  })
})
