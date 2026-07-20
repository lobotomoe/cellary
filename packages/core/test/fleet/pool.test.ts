import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock the observer + provisioner boundary ────────────────────────────────
//
// ModemPool sits on top of DeviceObserver and the readiness pipeline. We mock
// the observer (so tests emit device lifecycle events directly) and the
// provisioner (so the pipeline never touches real USB). Modem.connectFromPrepared
// is stubbed per-test via vi.spyOn.

const observerHolder = vi.hoisted((): { current: EventEmitter | undefined } => ({
  current: undefined,
}))

vi.mock('../../src/discovery/observer.js', async () => {
  const { EventEmitter: EE } = await import('node:events')
  class FakeObserver extends EE {
    start = vi.fn(async () => {})
    dispose = vi.fn(() => {})
    pauseWatcher = vi.fn(() => {})
    resumeWatcher = vi.fn(() => {})
    constructor() {
      super()
      observerHolder.current = this
    }
  }
  return { DeviceObserver: FakeObserver }
})

vi.mock('../../src/discovery/provisioner.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/discovery/provisioner.js')>()
  return { ...actual, provision: vi.fn() }
})

import { provision } from '../../src/discovery/provisioner.js'
import { ModemPool } from '../../src/fleet/pool.js'
import { Modem } from '../../src/modem.js'
import type { PrepReport } from '../../src/preparation/types.js'
import { MockTransport } from '../../src/transport/mock.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

const DEVICE_ID = '12d1:1-2'
const VENDOR_ID = 0x12d1

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: DEVICE_ID,
    vendorId: VENDOR_ID,
    vendorName: 'Test Modem',
    serialNumber: undefined,
    currentCycle: {
      pid: 0x1506,
      name: 'Test Modem',
      attachedAt: 0,
      detachedAt: undefined,
      modem: {},
    },
    history: [],
    firstSeenAt: 0,
    state: 'on-bus',
    completedCycleCount: 0,
    avgOnBusDurationMs: undefined,
    avgOffBusDurationMs: undefined,
    ...overrides,
  }
}

function analysis(severity: 'normal' | 'degraded' | 'critical', description: string) {
  return {
    state: severity === 'critical' ? 'boot-loop' : 'stable',
    severity,
    description,
    recommendations: [],
    expectedNextPid: undefined,
    estimatedRecoveryMs: undefined,
  }
}

const READY_REPORT: PrepReport = {
  device: { name: 'test', vendorId: VENDOR_ID, productId: 0x1506 },
  verdict: 'ready',
  steps: [],
  limitations: [],
  remediations: [],
  recommendations: [],
  durationMs: 0,
}

/**
 * A modem whose health check passed -- pipeline reaches the 'ready' stage.
 *
 * A real Modem (via MockTransport, autoInit off so no AT traffic or timers) so
 * the mocked connectFromPrepared returns the genuine type. open() leaves the
 * preparation report undefined, so surface the ready verdict the pipeline reads.
 */
async function makeReadyModem(): Promise<Modem> {
  const modem = await Modem.open({
    path: '',
    transport: new MockTransport(),
    profile: { name: 'test', at: { initCommands: [], urcPrefixes: [] } },
    autoInit: false,
    reconnect: false,
  })
  Object.defineProperty(modem, 'preparation', { get: () => READY_REPORT, configurable: true })
  return modem
}

const ASSESSMENT_TIMEOUT_MS = 30_000

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ModemPool', () => {
  let pool: ModemPool
  let observer: EventEmitter
  let stages: string[]

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.mocked(provision).mockResolvedValue({
      transport: { type: 'serial', path: '' },
      driver: { kind: 'at' },
      profile: { name: 'test' },
    })
    // Fresh modem per connect so distinct devices get distinct instances.
    vi.spyOn(Modem, 'connectFromPrepared').mockImplementation(() => makeReadyModem())

    pool = new ModemPool({ resolvers: [] })
    const current = observerHolder.current
    if (current === undefined) throw new Error('observer not constructed')
    observer = current

    stages = []
    pool.on('device:readiness', (device) => {
      stages.push(device.readiness.stage)
    })

    await pool.start()
  })

  afterEach(async () => {
    await pool.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    observerHolder.current = undefined
  })

  describe('assessment-timeout recovery (FLT-C2)', () => {
    it('recovers a stalled device once it leaves the critical state', async () => {
      // Device appears in a critical state (boot-loop): assessment defers.
      observer.emit('device:appeared', makeSession(), analysis('critical', 'boot loop'))
      expect(pool.byStage('assessing')).toHaveLength(1)

      // Assessment times out -> parked in a recoverable error (not a dead end).
      await vi.advanceTimersByTimeAsync(ASSESSMENT_TIMEOUT_MS)
      const errored = pool.byStage('error')
      expect(errored).toHaveLength(1)
      expect(errored[0]?.readiness).toMatchObject({ stage: 'error', recoverable: true })

      // The device leaves the critical state on the bus (no physical replug).
      // The same device:state-changed signal that would have advanced assessment
      // before the timeout must now un-stick the parked error.
      observer.emit(
        'device:state-changed',
        makeSession(),
        analysis('normal', 'stable'),
        analysis('critical', 'boot loop'),
      )
      await vi.runAllTimersAsync()

      // It resumed assessment, ran the pipeline, and reached ready.
      expect(stages).toContain('preparing')
      expect(pool.byStage('ready')).toHaveLength(1)
    })

    it('does not churn while the device stays critical', async () => {
      observer.emit('device:appeared', makeSession(), analysis('critical', 'boot loop'))
      await vi.advanceTimersByTimeAsync(ASSESSMENT_TIMEOUT_MS)
      expect(pool.byStage('error')).toHaveLength(1)

      // A still-critical state-changed must not re-drive the pipeline.
      observer.emit(
        'device:state-changed',
        makeSession(),
        analysis('critical', 'still boot looping'),
        analysis('critical', 'boot loop'),
      )
      await vi.runAllTimersAsync()

      expect(pool.byStage('error')).toHaveLength(1)
      expect(stages).not.toContain('preparing')
      expect(provision).not.toHaveBeenCalled()
    })
  })

  describe('waitForDeviceId (CLI-C1)', () => {
    it('resolves when the targeted device becomes ready', async () => {
      const waiting = pool.waitForDeviceId(DEVICE_ID)
      observer.emit('device:appeared', makeSession(), analysis('normal', 'stable'))
      // Bounded flush: drive the microtask pipeline without firing the wait's
      // own 60s timeout (runAllTimersAsync would fire it and reject the wait).
      await vi.advanceTimersByTimeAsync(100)

      const modem = await waiting
      expect(modem).toBeDefined()
      expect(pool.byStage('ready')).toHaveLength(1)
    })

    it('is not resolved by a different device becoming ready', async () => {
      const waiting = pool.waitForDeviceId('12d1:9-9')
      let settled = false
      waiting.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

      observer.emit(
        'device:appeared',
        makeSession({ deviceId: 'other:1-1' }),
        analysis('normal', 'stable'),
      )
      // Bounded flush (below the 60s wait timeout) so the unrelated device
      // reaches ready while our targeted wait is still legitimately pending.
      await vi.advanceTimersByTimeAsync(100)

      // The unrelated device is ready, but our targeted wait stays pending.
      expect(pool.byStage('ready')).toHaveLength(1)
      expect(settled).toBe(false)
    })
  })
})
