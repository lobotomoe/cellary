import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock USB module ──────────────────────────────────────────────────────────

const { mockGetDeviceList, mockUsb } = vi.hoisted(() => {
  // Listener store shared via closure — must be cleared between tests
  const listeners = new Map<string, Set<(device: unknown) => void>>()

  const usbMock = {
    on: vi.fn((event: string, listener: (device: unknown) => void) => {
      let eventListeners = listeners.get(event)
      if (eventListeners === undefined) {
        eventListeners = new Set()
        listeners.set(event, eventListeners)
      }
      eventListeners.add(listener)
    }),
    off: vi.fn((event: string, listener: (device: unknown) => void) => {
      listeners.get(event)?.delete(listener)
    }),
    // Test helper: fire an event on all registered listeners
    _emit: (event: string, device: unknown) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(device)
      }
    },
    // Test helper: clear all registered listeners between tests
    _reset: () => {
      listeners.clear()
    },
  }

  return {
    mockGetDeviceList: vi.fn(() => [] as unknown[]),
    mockUsb: usbMock,
  }
})

vi.mock('usb', () => ({
  usb: mockUsb,
  getDeviceList: mockGetDeviceList,
}))

import { watch } from '../../src/discovery/watcher.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockDevice(vendorId: number, productId: number) {
  return { deviceDescriptor: { idVendor: vendorId, idProduct: productId } }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('watch()', () => {
  beforeEach(() => {
    mockGetDeviceList.mockReset().mockReturnValue([])
    mockUsb.on.mockClear()
    mockUsb.off.mockClear()
    mockUsb._reset()
  })

  it('returns a stop function', () => {
    const stop = watch(() => {})
    expect(typeof stop).toBe('function')
    stop()
  })

  it('registers attach and detach listeners on start', () => {
    watch(() => {})
    expect(mockUsb.on).toHaveBeenCalledWith('attach', expect.any(Function))
    expect(mockUsb.on).toHaveBeenCalledWith('detach', expect.any(Function))
  })

  it('unregisters listeners when stop is called', () => {
    const stop = watch(() => {})
    stop()
    expect(mockUsb.off).toHaveBeenCalledWith('attach', expect.any(Function))
    expect(mockUsb.off).toHaveBeenCalledWith('detach', expect.any(Function))
  })

  it('emits attached event when a known modem connects', () => {
    const listener = vi.fn()
    watch(listener)

    mockUsb._emit('attach', createMockDevice(0x12d1, 0x1506))

    expect(listener).toHaveBeenCalledOnce()
    const [call] = listener.mock.calls
    if (call === undefined) throw new Error('expected listener to have been called')
    const [event] = call
    expect(event.type).toBe('attached')
    expect(event.modem).toMatchObject({
      mode: 'modem-usb',
      vendorId: 0x12d1,
      productId: 0x1506,
      name: 'Huawei',
    })
  })

  it('emits attached event with http mode for HiLink device', () => {
    const listener = vi.fn()
    watch(listener)

    mockUsb._emit('attach', createMockDevice(0x12d1, 0x14db))

    expect(listener).toHaveBeenCalledOnce()
    const [call] = listener.mock.calls
    if (call === undefined) throw new Error('expected listener to have been called')
    const [event] = call
    expect(event.type).toBe('attached')
    expect(event.modem).toMatchObject({ mode: 'http', url: 'http://192.168.8.1' })
  })

  it('emits attached event with storage mode for storage-mode device', () => {
    const listener = vi.fn()
    watch(listener)

    mockUsb._emit('attach', createMockDevice(0x12d1, 0x14fe))

    expect(listener).toHaveBeenCalledOnce()
    const [call] = listener.mock.calls
    if (call === undefined) throw new Error('expected listener to have been called')
    const [event] = call
    expect(event.modem.mode).toBe('storage')
  })

  it('ignores unknown devices', () => {
    const listener = vi.fn()
    watch(listener)

    mockUsb._emit('attach', createMockDevice(0xffff, 0x0001))

    expect(listener).not.toHaveBeenCalled()
  })

  it('emits detached event when a tracked modem disconnects', () => {
    const listener = vi.fn()
    watch(listener)

    const device = createMockDevice(0x12d1, 0x1506)
    mockUsb._emit('attach', device)
    mockUsb._emit('detach', device)

    expect(listener).toHaveBeenCalledTimes(2)
    const [, secondCall] = listener.mock.calls
    if (secondCall === undefined) throw new Error('expected listener to have been called twice')
    const [detachEvent] = secondCall
    expect(detachEvent.type).toBe('detached')
    expect(detachEvent.modem.mode).toBe('modem-usb')
  })

  it('does not emit detached for untracked device', () => {
    const listener = vi.fn()
    watch(listener)

    // detach without prior attach
    mockUsb._emit('detach', createMockDevice(0x12d1, 0x1506))

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not emit for already-connected devices (seed only, no events)', () => {
    const seedDevice = createMockDevice(0x12d1, 0x1506)
    mockGetDeviceList.mockReturnValue([seedDevice])

    const listener = vi.fn()
    watch(listener)

    // No event for devices present at startup
    expect(listener).not.toHaveBeenCalled()
  })

  it('tracks seeded devices so detach fires for them', () => {
    const seedDevice = createMockDevice(0x12d1, 0x1506)
    mockGetDeviceList.mockReturnValue([seedDevice])

    const listener = vi.fn()
    watch(listener)

    mockUsb._emit('detach', seedDevice)

    expect(listener).toHaveBeenCalledOnce()
    const [call] = listener.mock.calls
    if (call === undefined) throw new Error('expected listener to have been called')
    const [event] = call
    expect(event.type).toBe('detached')
  })

  it('does not emit duplicate attached for same device', () => {
    const listener = vi.fn()
    watch(listener)

    const device = createMockDevice(0x12d1, 0x1506)
    mockUsb._emit('attach', device)
    mockUsb._emit('attach', device) // duplicate

    expect(listener).toHaveBeenCalledOnce()
  })

  it('after stop, no events are emitted', () => {
    const listener = vi.fn()
    const stop = watch(listener)
    stop()

    mockUsb._emit('attach', createMockDevice(0x12d1, 0x1506))

    expect(listener).not.toHaveBeenCalled()
  })
})
