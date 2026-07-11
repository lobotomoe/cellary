import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// -- Mock scanner and watcher ------------------------------------------------

// We mock at the scanner/watcher level, not at the `usb` level.
// DeviceObserver depends on scanUsb() and watch(), not on libusb directly.

type WatchListener = (event: { type: 'attached' | 'detached'; modem: MockModem }) => void

interface MockModem {
  readonly mode: string
  readonly vendorId: number
  readonly productId: number
  readonly deviceId: string
  readonly name: string
  readonly entry: { readonly vendor: number; readonly name: string }
  readonly busNumber: number
  readonly portNumbers: readonly number[]
}

const { mockScan, mockWatch } = vi.hoisted(() => {
  let _watchListener: WatchListener | undefined
  let _watchStop = vi.fn()

  return {
    mockScan: vi.fn((): MockModem[] => []),
    mockWatch: Object.assign(
      vi.fn((listener: WatchListener) => {
        _watchListener = listener
        _watchStop = vi.fn()
        return _watchStop
      }),
      {
        /** Simulate a USB attach event */
        _attach(modem: MockModem) {
          _watchListener?.({ type: 'attached', modem })
        },
        /** Simulate a USB detach event */
        _detach(modem: MockModem) {
          _watchListener?.({ type: 'detached', modem })
        },
        _getStop() {
          return _watchStop
        },
        _reset() {
          _watchListener = undefined
        },
      },
    ),
  }
})

vi.mock('../../src/discovery/scanner.js', () => ({
  scanUsb: mockScan,
}))

vi.mock('../../src/discovery/watcher.js', () => ({
  watch: mockWatch,
}))

import { DeviceObserver } from '../../src/discovery/observer.js'
import type {
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
} from '../../src/discovery/observer-types.js'

// -- Helpers -----------------------------------------------------------------

const HUAWEI_VID = 0x12d1
const QUALCOMM_VID = 0x05c6

function makeModem(
  vendorId: number,
  productId: number,
  name: string,
  busNumber = 1,
  portNumbers: readonly number[] = [1],
): MockModem {
  const portPath = portNumbers.length > 0 ? portNumbers.join('.') : '0'
  return {
    mode: 'modem-usb',
    vendorId,
    productId,
    deviceId: `${vendorId}:${busNumber}-${portPath}`,
    name,
    entry: { vendor: vendorId, name },
    busNumber,
    portNumbers,
  }
}

const huaweiModem = makeModem(HUAWEI_VID, 0x1506, 'Huawei', 1, [1])
const qualcommModem = makeModem(QUALCOMM_VID, 0x90b6, 'Qualcomm MiFi', 1, [2])

/** Narrows `T | undefined` to `T`, throwing if the precondition doesn't hold. */
function requireDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

// -- Tests -------------------------------------------------------------------

describe('DeviceObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockScan.mockReset().mockReturnValue([])
    mockWatch.mockClear()
    mockWatch._reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -- Lifecycle -------------------------------------------------------------

  it('subscribes to watch() on start', async () => {
    const observer = new DeviceObserver()
    await observer.start()
    expect(mockWatch).toHaveBeenCalledOnce()
    observer.dispose()
  })

  it('does not double-start', async () => {
    const observer = new DeviceObserver()
    await observer.start()
    await observer.start()
    expect(mockWatch).toHaveBeenCalledOnce()
    observer.dispose()
  })

  it('calls watch stop on dispose', async () => {
    const observer = new DeviceObserver()
    await observer.start()
    const stop = mockWatch._getStop()
    observer.dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  // -- Seeding ---------------------------------------------------------------

  it('emits device:appeared for devices present at start', async () => {
    mockScan.mockReturnValue([huaweiModem])
    const observer = new DeviceObserver()
    const listener = vi.fn()
    observer.on('device:appeared', listener)
    await observer.start()

    expect(listener).toHaveBeenCalledOnce()
    const call = requireDefined(listener.mock.calls[0], 'expected listener to have been called')
    const [session] = call
    expect(session.vendorId).toBe(HUAWEI_VID)
    expect(session.state).toBe('on-bus')
    observer.dispose()
  })

  // -- Attach/detach events --------------------------------------------------

  it('emits device:appeared for first-time attach', async () => {
    const observer = new DeviceObserver()
    const appeared = vi.fn()
    observer.on('device:appeared', appeared)
    await observer.start()

    mockWatch._attach(huaweiModem)

    expect(appeared).toHaveBeenCalledOnce()
    const call = requireDefined(appeared.mock.calls[0], 'expected appeared to have been called')
    const [session, analysis] = call
    expect(session.vendorId).toBe(HUAWEI_VID)
    expect(session.state).toBe('on-bus')
    expect(analysis.state).toBe('connected')
    observer.dispose()
  })

  it('emits device:attached on reconnect (not device:appeared)', async () => {
    const observer = new DeviceObserver()
    const appeared = vi.fn()
    const attached = vi.fn()
    observer.on('device:appeared', appeared)
    observer.on('device:attached', attached)
    await observer.start()

    // First attach
    mockWatch._attach(huaweiModem)
    // Detach
    mockWatch._detach(huaweiModem)
    // Reattach
    mockWatch._attach(huaweiModem)

    expect(appeared).toHaveBeenCalledOnce() // only the first time
    expect(attached).toHaveBeenCalledOnce() // the reconnect
    observer.dispose()
  })

  it('emits device:detached when device leaves bus', async () => {
    const observer = new DeviceObserver()
    const detached = vi.fn()
    observer.on('device:detached', detached)
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)

    expect(detached).toHaveBeenCalledOnce()
    const call = requireDefined(detached.mock.calls[0], 'expected detached to have been called')
    const [session, analysis] = call
    expect(session.state).toBe('off-bus')
    expect(analysis.state).toBe('disconnected')
    observer.dispose()
  })

  // -- Session tracking ------------------------------------------------------

  it('tracks cycle history', async () => {
    const observer = new DeviceObserver()
    const detached = vi.fn()
    observer.on('device:detached', detached)
    await observer.start()

    // Cycle 1
    mockWatch._attach(huaweiModem)
    vi.advanceTimersByTime(5_000)
    mockWatch._detach(huaweiModem)

    const call1 = requireDefined(detached.mock.calls[0], 'expected first detached call')
    const [session1] = call1
    expect(session1.completedCycleCount).toBe(1)
    expect(session1.history).toHaveLength(1)
    const entry1 = requireDefined(session1.history[0], 'expected first history entry')
    expect(entry1.pid).toBe(0x1506)

    // Cycle 2
    vi.advanceTimersByTime(2_000)
    mockWatch._attach(huaweiModem)
    vi.advanceTimersByTime(3_000)
    mockWatch._detach(huaweiModem)

    const call2 = requireDefined(detached.mock.calls[1], 'expected second detached call')
    const [session2] = call2
    expect(session2.completedCycleCount).toBe(2)
    expect(session2.history).toHaveLength(2)
    // Most recent first
    const entry2 = requireDefined(session2.history[0], 'expected second history entry')
    expect(entry2.pid).toBe(0x1506)
    observer.dispose()
  })

  it('computes average durations after 2+ cycles', async () => {
    const observer = new DeviceObserver()
    const detached = vi.fn()
    observer.on('device:detached', detached)
    await observer.start()

    // Cycle 1: 8s on bus
    mockWatch._attach(huaweiModem)
    vi.advanceTimersByTime(8_000)
    mockWatch._detach(huaweiModem)

    const call1 = requireDefined(detached.mock.calls[0], 'expected first detached call')
    const [session1] = call1
    expect(session1.avgOnBusDurationMs).toBeUndefined() // only 1 cycle

    // Gap: 18s
    vi.advanceTimersByTime(18_000)

    // Cycle 2: 10s on bus
    mockWatch._attach(huaweiModem)
    vi.advanceTimersByTime(10_000)
    mockWatch._detach(huaweiModem)

    const call2 = requireDefined(detached.mock.calls[1], 'expected second detached call')
    const [session2] = call2
    expect(session2.avgOnBusDurationMs).toBe(9_000) // (8000 + 10000) / 2
    expect(session2.avgOffBusDurationMs).toBe(18_000) // one gap
    observer.dispose()
  })

  it('caps cycle history at maxCycleHistory', async () => {
    const observer = new DeviceObserver({ maxCycleHistory: 3 })
    const detached = vi.fn()
    observer.on('device:detached', detached)
    await observer.start()

    for (let i = 0; i < 5; i++) {
      mockWatch._attach(huaweiModem)
      vi.advanceTimersByTime(1_000)
      mockWatch._detach(huaweiModem)
      vi.advanceTimersByTime(1_000)
    }

    const lastCall = requireDefined(
      detached.mock.calls[detached.mock.calls.length - 1],
      'expected at least one detached call',
    )
    const [session] = lastCall
    expect(session.history).toHaveLength(3) // capped
    expect(session.completedCycleCount).toBe(3) // reflects capped length
    observer.dispose()
  })

  // -- Gone timeout ----------------------------------------------------------

  it('emits device:gone after goneTimeoutMs', async () => {
    const observer = new DeviceObserver({ goneTimeoutMs: 10_000 })
    const gone = vi.fn()
    observer.on('device:gone', gone)
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)

    expect(gone).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(gone).toHaveBeenCalledOnce()
    observer.dispose()
  })

  it('cancels gone timer on reattach', async () => {
    const observer = new DeviceObserver({ goneTimeoutMs: 10_000 })
    const gone = vi.fn()
    observer.on('device:gone', gone)
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)
    vi.advanceTimersByTime(5_000)
    mockWatch._attach(huaweiModem)
    vi.advanceTimersByTime(10_000)

    expect(gone).not.toHaveBeenCalled()
    observer.dispose()
  })

  it('cleans up session after gone', async () => {
    const observer = new DeviceObserver({ goneTimeoutMs: 1_000 })
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)
    vi.advanceTimersByTime(1_000)

    expect(observer.sessions.size).toBe(0)
    observer.dispose()
  })

  // -- Sessions map ----------------------------------------------------------

  it('exposes active sessions', async () => {
    const observer = new DeviceObserver()
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._attach(qualcommModem)

    expect(observer.sessions.size).toBe(2)
    // Key is deviceId format: "vendorId:busNumber-portPath"
    const huaweiSession = observer.sessions.get(`${HUAWEI_VID}:1-1`)
    expect(huaweiSession).toBeDefined()
    const definedHuaweiSession = requireDefined(
      huaweiSession,
      'expected huaweiSession to be defined',
    )
    expect(definedHuaweiSession.vendorName).toBe('Huawei')
    observer.dispose()
  })

  // -- Vendor resolver -------------------------------------------------------

  it('uses vendor resolver when vendorId matches', async () => {
    const customResolver: DeviceStateResolver = {
      vendorId: HUAWEI_VID,
      analyze: vi.fn(
        (_session: DeviceSessionSnapshot): DeviceStateAnalysis => ({
          state: 'mode-switching',
          severity: 'normal',
          description: 'Switching from storage to modem mode',
          recommendations: [],
          expectedNextPid: 0x1506,
          estimatedRecoveryMs: 5_000,
        }),
      ),
    }

    const observer = new DeviceObserver({ resolvers: [customResolver] })
    const appeared = vi.fn()
    observer.on('device:appeared', appeared)
    await observer.start()

    mockWatch._attach(huaweiModem)

    expect(customResolver.analyze).toHaveBeenCalledOnce()
    const call = requireDefined(appeared.mock.calls[0], 'expected appeared to have been called')
    const [, analysis] = call
    expect(analysis.state).toBe('mode-switching')
    observer.dispose()
  })

  it('falls back to generic analysis when no resolver matches', async () => {
    const resolver: DeviceStateResolver = {
      vendorId: 0x9999, // doesn't match
      analyze: vi.fn(),
    }

    const observer = new DeviceObserver({ resolvers: [resolver] })
    const appeared = vi.fn()
    observer.on('device:appeared', appeared)
    await observer.start()

    mockWatch._attach(huaweiModem)

    expect(resolver.analyze).not.toHaveBeenCalled()
    const call = requireDefined(appeared.mock.calls[0], 'expected appeared to have been called')
    const [, analysis] = call
    expect(analysis.state).toBe('connected')
    observer.dispose()
  })

  // -- State change detection ------------------------------------------------

  it('emits device:state-changed when analysis changes', async () => {
    let callCount = 0
    const resolver: DeviceStateResolver = {
      vendorId: HUAWEI_VID,
      analyze(_session: DeviceSessionSnapshot): DeviceStateAnalysis {
        callCount++
        // First call: cold-start. After detach+reattach: cycling.
        const state = callCount <= 1 ? 'cold-start' : 'cycling'
        return {
          state,
          severity: 'normal',
          description: state,
          recommendations: [],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      },
    }

    const observer = new DeviceObserver({ resolvers: [resolver] })
    const stateChanged = vi.fn()
    observer.on('device:state-changed', stateChanged)
    await observer.start()

    mockWatch._attach(huaweiModem) // cold-start
    mockWatch._detach(huaweiModem) // still cold-start (callCount=2 -> cycling)
    // The detach triggers analysis with 'cycling', which differs from 'cold-start'

    expect(stateChanged).toHaveBeenCalledOnce()
    const call = requireDefined(
      stateChanged.mock.calls[0],
      'expected stateChanged to have been called',
    )
    const [, analysis, previous] = call
    expect(previous.state).toBe('cold-start')
    expect(analysis.state).toBe('cycling')
    observer.dispose()
  })

  it('does not emit device:state-changed when analysis stays the same', async () => {
    const resolver: DeviceStateResolver = {
      vendorId: HUAWEI_VID,
      analyze(): DeviceStateAnalysis {
        return {
          state: 'stable',
          severity: 'normal',
          description: 'stable',
          recommendations: [],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      },
    }

    const observer = new DeviceObserver({ resolvers: [resolver] })
    const stateChanged = vi.fn()
    observer.on('device:state-changed', stateChanged)
    await observer.start()

    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)
    mockWatch._attach(huaweiModem)
    mockWatch._detach(huaweiModem)

    expect(stateChanged).not.toHaveBeenCalled()
    observer.dispose()
  })
})
