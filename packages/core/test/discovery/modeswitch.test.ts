import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock USB module ─────────────────────────────────────────────────────────

const { MockOutEndpoint, MockInEndpoint, mockGetDeviceList, mockFindByIds } = vi.hoisted(() => {
  const getDeviceListMock = vi.fn(() => [] as unknown[])
  const findByIdsMock = vi.fn(() => undefined as unknown)

  class OutEndpointMock {
    address: number
    direction = 'out' as const
    transferType = 2
    timeout = 0
    transfer = vi.fn((_data: Buffer, cb: (err: Error | undefined) => void) => {
      cb(undefined)
    })

    constructor(address: number) {
      this.address = address
    }
  }

  class InEndpointMock {
    address: number
    direction = 'in' as const
    transferType = 2
    timeout = 0
    transfer = vi.fn((_length: number, cb: (err: Error | undefined, data?: Buffer) => void) => {
      // Return minimal valid CSW: signature + tag + residue + status(passed)
      const csw = Buffer.alloc(13)
      csw.writeUInt32LE(0x53425355, 0) // USBS signature
      csw.writeUInt32LE(0, 4) // tag
      csw.writeUInt32LE(0, 8) // residue
      csw.writeUInt8(0, 12) // status = passed
      cb(undefined, csw)
    })

    constructor(address: number) {
      this.address = address
    }
  }

  return {
    MockOutEndpoint: OutEndpointMock,
    MockInEndpoint: InEndpointMock,
    mockGetDeviceList: getDeviceListMock,
    mockFindByIds: findByIdsMock,
  }
})

vi.mock('usb', () => ({
  usb: {
    LIBUSB_TRANSFER_TYPE_BULK: 2,
    LIBUSB_CLASS_MASS_STORAGE: 8,
  },
  getDeviceList: mockGetDeviceList,
  findByIds: mockFindByIds,
  OutEndpoint: MockOutEndpoint,
  InEndpoint: MockInEndpoint,
}))

import type { ScsiCbwSwitch, VendorControlSwitch } from '../../src/discovery/modeswitch.js'
import { switchDevice } from '../../src/discovery/modeswitch.js'

// ── Test data ───────────────────────────────────────────────────────────────

const VENDOR = 0x12d1
const STORAGE_PID = 0x14fe
const MODEM_PID = 0x1506
const MODEM_PIDS = new Set([MODEM_PID])
const isModemPid = (pid: number) => MODEM_PIDS.has(pid)

const SCSI_SWITCH: ScsiCbwSwitch = {
  type: 'scsi-cbw',
  command: new Uint8Array([0x55, 0x53, 0x42, 0x43]),
}

const VENDOR_SWITCH: VendorControlSwitch = {
  type: 'vendor-control',
  requestType: 0x40,
  request: 0xa1,
  value: 0x00,
  index: 0x00,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockMassStorageInterface() {
  const outEndpoint = new MockOutEndpoint(0x02)
  const inEndpoint = new MockInEndpoint(0x82)
  return {
    descriptor: { bInterfaceNumber: 0, bInterfaceClass: 8, bInterfaceProtocol: 0 },
    endpoints: [outEndpoint, inEndpoint],
    isKernelDriverActive: vi.fn(() => false),
    detachKernelDriver: vi.fn(),
    claim: vi.fn(),
    release: vi.fn((cb: () => void) => cb()),
    _outEndpoint: outEndpoint,
  }
}

function createMockDevice(interfaces: ReturnType<typeof createMockMassStorageInterface>[]) {
  return {
    deviceDescriptor: { idVendor: VENDOR, idProduct: STORAGE_PID },
    interfaces,
    open: vi.fn(),
    close: vi.fn(),
    setAutoDetachKernelDriver: vi.fn(),
    interface: vi.fn((n: number) => interfaces[n]),
    controlTransfer: vi.fn(
      (
        _rt: number,
        _req: number,
        _val: number,
        _idx: number,
        _data: Buffer,
        cb: (err: Error | undefined) => void,
      ) => {
        cb(undefined)
      },
    ),
  }
}

function createSwitchedDevice() {
  return {
    deviceDescriptor: { idVendor: VENDOR, idProduct: MODEM_PID },
    interfaces: [],
    open: vi.fn(),
    close: vi.fn(),
    interface: vi.fn(),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('modeswitch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetDeviceList.mockReset()
    mockFindByIds.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('SCSI CBW switch', () => {
    // SCSI CBW uses a launchd job on macOS (IOKit isolation).
    // Unit tests exercise the in-process path (Linux).
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('sends CBW command via mass storage and detects re-enumeration', async () => {
      const iface = createMockMassStorageInterface()
      const device = createMockDevice([iface])
      mockFindByIds.mockReturnValue(device)

      let callCount = 0
      mockGetDeviceList.mockImplementation(() => {
        callCount++
        return callCount >= 2 ? [createSwitchedDevice()] : []
      })

      const promise = switchDevice(VENDOR, STORAGE_PID, SCSI_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(6_000)

      const result = await promise

      expect(result.switched).toBe(true)
      expect(result.newProductId).toBe(MODEM_PID)
      expect(iface.claim).toHaveBeenCalled()
      expect(iface._outEndpoint.transfer).toHaveBeenCalled()
    })

    it('returns switched=false when the interface has no bulk OUT endpoint', async () => {
      const iface = createMockMassStorageInterface()
      iface.endpoints = []
      const device = createMockDevice([iface])
      mockFindByIds.mockReturnValue(device)

      // No usable endpoint and no helper registered -> method fails, switch does
      // not succeed. The caller (lifecycle action) is what surfaces this to the
      // user; switchDevice only reports the outcome.
      const result = await switchDevice(VENDOR, STORAGE_PID, SCSI_SWITCH, isModemPid)

      expect(result.switched).toBe(false)
    })

    it('auto-detaches kernel driver before claiming', async () => {
      const iface = createMockMassStorageInterface()
      const device = createMockDevice([iface])
      mockFindByIds.mockReturnValue(device)

      mockGetDeviceList.mockReturnValue([createSwitchedDevice()])

      const promise = switchDevice(VENDOR, STORAGE_PID, SCSI_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(4_000)

      await promise

      expect(device.setAutoDetachKernelDriver).toHaveBeenCalledWith(true)
    })
  })

  describe('vendor control switch', () => {
    // Vendor control is the Linux/other in-process path; macOS uses diskutil.
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('sends control transfer and detects re-enumeration', async () => {
      const device = createMockDevice([])
      mockFindByIds.mockReturnValue(device)

      let callCount = 0
      mockGetDeviceList.mockImplementation(() => {
        callCount++
        return callCount >= 2 ? [createSwitchedDevice()] : []
      })

      const promise = switchDevice(VENDOR, STORAGE_PID, VENDOR_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(6_000)

      const result = await promise

      expect(result.switched).toBe(true)
      expect(result.newProductId).toBe(MODEM_PID)
      expect(device.controlTransfer).toHaveBeenCalledWith(
        0x40,
        0xa1,
        0x00,
        0x00,
        expect.any(Buffer),
        expect.any(Function),
      )
    })

    it('does not require mass storage interface', async () => {
      const device = createMockDevice([])
      mockFindByIds.mockReturnValue(device)

      mockGetDeviceList.mockReturnValue([createSwitchedDevice()])

      const promise = switchDevice(VENDOR, STORAGE_PID, VENDOR_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(4_000)

      const result = await promise

      expect(result.switched).toBe(true)
    })

    it('absorbs STALL errors (expected during disconnect)', async () => {
      const device = createMockDevice([])
      mockFindByIds.mockReturnValue(device)
      device.controlTransfer.mockImplementation(
        (
          _rt: number,
          _req: number,
          _val: number,
          _idx: number,
          _data: Buffer,
          cb: (err: Error | undefined) => void,
        ) => {
          cb(new Error('LIBUSB_TRANSFER_STALL'))
        },
      )

      mockGetDeviceList.mockReturnValue([createSwitchedDevice()])

      const promise = switchDevice(VENDOR, STORAGE_PID, VENDOR_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(4_000)

      const result = await promise

      expect(result.switched).toBe(true)
    })

    it('treats a non-STALL control transfer error as method failure', async () => {
      const device = createMockDevice([])
      mockFindByIds.mockReturnValue(device)
      device.controlTransfer.mockImplementation(
        (
          _rt: number,
          _req: number,
          _val: number,
          _idx: number,
          _data: Buffer,
          cb: (err: Error | undefined) => void,
        ) => {
          cb(new Error('LIBUSB_ERROR_ACCESS'))
        },
      )

      // A real (non-STALL) error aborts the method before polling. The switched
      // device is present on the bus, but the failed method is not credited with
      // the switch -- switchDevice moves on and, with no more methods, reports false.
      mockGetDeviceList.mockReturnValue([createSwitchedDevice()])

      const result = await switchDevice(VENDOR, STORAGE_PID, VENDOR_SWITCH, isModemPid)

      expect(result.switched).toBe(false)
    })
  })

  describe('polling', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { ...process, platform: 'linux' })
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns switched=false when device does not re-enumerate', async () => {
      const iface = createMockMassStorageInterface()
      const device = createMockDevice([iface])
      mockFindByIds.mockReturnValue(device)

      mockGetDeviceList.mockReturnValue([])

      const promise = switchDevice(VENDOR, STORAGE_PID, SCSI_SWITCH, isModemPid)
      await vi.advanceTimersByTimeAsync(20_000)

      const result = await promise

      expect(result.switched).toBe(false)
      expect(result.newProductId).toBeUndefined()
    })
  })
})
