import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock USB module ─────────────────────────────────────────────────────────

type DataHandler = (data: Buffer) => void
type ErrorHandler = (error: Error) => void

const { MockInEndpoint, MockOutEndpoint, mockFindByIds } = vi.hoisted(() => {
  const findByIdsMock = vi.fn()

  class InEndpointMock {
    address: number
    direction = 'in' as const
    transferType = 2
    startPoll = vi.fn()
    stopPoll = vi.fn((cb?: () => void) => {
      cb?.()
    })
    removeAllListeners = vi.fn()
    on = vi.fn()

    private _dataHandler: DataHandler | null = null
    private _errorHandler: ErrorHandler | null = null

    constructor(address: number) {
      this.address = address
      // node-usb dispatches 'data' with a Buffer and 'error' with an Error;
      // the captured handler is stored in the slot matching the event.
      this.on.mockImplementation((event: string, handler: DataHandler & ErrorHandler) => {
        if (event === 'data') this._dataHandler = handler
        if (event === 'error') this._errorHandler = handler
      })
    }

    _emitData(data: Buffer) {
      this._dataHandler?.(data)
    }
    _emitError(error: Error) {
      this._errorHandler?.(error)
    }
  }

  class OutEndpointMock {
    address: number
    direction = 'out' as const
    transferType = 2
    transfer = vi.fn((_data: Buffer, cb: (err: Error | undefined) => void) => {
      cb(undefined)
    })

    constructor(address: number) {
      this.address = address
    }
  }

  return {
    MockInEndpoint: InEndpointMock,
    MockOutEndpoint: OutEndpointMock,
    mockFindByIds: findByIdsMock,
  }
})

vi.mock('usb', () => ({
  usb: { LIBUSB_TRANSFER_TYPE_BULK: 2 },
  findByIds: mockFindByIds,
  InEndpoint: MockInEndpoint,
  OutEndpoint: MockOutEndpoint,
}))

import { UsbTransport } from '../../src/transport/usb.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

function createMockEndpoints() {
  const inEndpoint = new MockInEndpoint(0x81)
  const outEndpoint = new MockOutEndpoint(0x02)
  return { inEndpoint, outEndpoint }
}

function createMockInterface(endpoints: ReturnType<typeof createMockEndpoints>) {
  return {
    descriptor: { bInterfaceNumber: 1, bInterfaceClass: 255, bInterfaceProtocol: 0 },
    endpoints: [endpoints.inEndpoint, endpoints.outEndpoint],
    isKernelDriverActive: vi.fn(() => false),
    detachKernelDriver: vi.fn(),
    claim: vi.fn(),
    release: vi.fn((cb: (err: Error | undefined) => void) => cb(undefined)),
  }
}

function createMockDevice(iface: ReturnType<typeof createMockInterface>) {
  return {
    deviceDescriptor: { idVendor: 0x12d1, idProduct: 0x1506 },
    interfaces: [iface],
    open: vi.fn(),
    close: vi.fn(),
    interface: vi.fn((_n: number) => iface),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UsbTransport', () => {
  let endpoints: ReturnType<typeof createMockEndpoints>
  let iface: ReturnType<typeof createMockInterface>
  let device: ReturnType<typeof createMockDevice>

  beforeEach(() => {
    endpoints = createMockEndpoints()
    iface = createMockInterface(endpoints)
    device = createMockDevice(iface)
    mockFindByIds.mockReturnValue(device)
  })

  describe('open()', () => {
    it('opens device, claims interface, starts polling', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()

      expect(device.open).toHaveBeenCalled()
      expect(iface.claim).toHaveBeenCalled()
      expect(endpoints.inEndpoint.startPoll).toHaveBeenCalled()
      expect(transport.isOpen).toBe(true)
    })

    it('throws when already open', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()
      await expect(transport.open()).rejects.toThrow('already open')
    })

    it('throws when device not found', async () => {
      mockFindByIds.mockReturnValue(undefined)

      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x9999,
        interfaceNumber: 1,
      })

      await expect(transport.open()).rejects.toThrow('USB device not found')
    })

    it('detaches kernel driver when active', async () => {
      iface.isKernelDriverActive.mockReturnValue(true)

      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()

      expect(iface.detachKernelDriver).toHaveBeenCalled()
    })

    it('uses custom poll parameters', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
        pollTransfers: 5,
        pollSize: 8192,
      })

      await transport.open()

      expect(endpoints.inEndpoint.startPoll).toHaveBeenCalledWith(5, 8192)
    })
  })

  describe('write()', () => {
    it('sends string data via bulk OUT endpoint', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()
      await transport.write('AT\r')

      expect(endpoints.outEndpoint.transfer).toHaveBeenCalled()
      const writtenData = vi.mocked(endpoints.outEndpoint.transfer).mock.calls[0]?.[0]
      expect(writtenData?.toString()).toBe('AT\r')
    })

    it('sends Uint8Array data via bulk OUT endpoint', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()
      const data = new Uint8Array([0x41, 0x54, 0x0d]) // "AT\r"
      await transport.write(data)

      expect(endpoints.outEndpoint.transfer).toHaveBeenCalled()
    })

    it('throws when not open', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await expect(transport.write('AT\r')).rejects.toThrow('not open')
    })

    it('wraps transfer errors in TransportError', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()

      endpoints.outEndpoint.transfer.mockImplementation(
        (_data: Buffer, cb: (err: Error | undefined) => void) => {
          cb(new Error('LIBUSB_ERROR_IO'))
        },
      )

      await expect(transport.write('AT\r')).rejects.toThrow('USB write failed')
    })
  })

  describe('onData()', () => {
    it('forwards data from IN endpoint to handler', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      const received: Uint8Array[] = []
      transport.onData((data) => received.push(data))

      await transport.open()

      // Simulate modem sending data
      const response = Buffer.from('\r\nOK\r\n')
      endpoints.inEndpoint._emitData(response)

      expect(received).toHaveLength(1)
      expect(Buffer.from(received[0] ?? []).toString()).toBe('\r\nOK\r\n')
    })
  })

  describe('close()', () => {
    it('stops polling, releases interface, closes device', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()
      await transport.close()

      expect(endpoints.inEndpoint.stopPoll).toHaveBeenCalled()
      expect(endpoints.inEndpoint.removeAllListeners).toHaveBeenCalled()
      expect(iface.release).toHaveBeenCalled()
      expect(device.close).toHaveBeenCalled()
      expect(transport.isOpen).toBe(false)
    })

    it('throws when not open', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await expect(transport.close()).rejects.toThrow('not open')
    })
  })

  describe('disconnect handling', () => {
    it('marks transport as closed on IN endpoint error', async () => {
      const transport = new UsbTransport({
        vendorId: 0x12d1,
        productId: 0x1506,
        interfaceNumber: 1,
      })

      await transport.open()
      expect(transport.isOpen).toBe(true)

      // Simulate USB disconnect
      endpoints.inEndpoint._emitError(new Error('LIBUSB_ERROR_NO_DEVICE'))

      expect(transport.isOpen).toBe(false)
    })
  })
})
