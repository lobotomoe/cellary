import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock the observer + provisioner boundary ────────────────────────────────
//
// ModemPool sits on top of DeviceObserver and the readiness pipeline. We mock
// the observer (so tests emit device lifecycle events directly) and the
// provisioner (so the pipeline never touches real USB). Modem.connectFromPrepared
// is stubbed per-test via vi.spyOn.

const observerHolder = vi.hoisted(() => ({ current: undefined as EventEmitter | undefined }))

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

/** A modem whose health check passed -- pipeline reaches the 'ready' stage. */
function makeReadyModem() {
  return Object.assign(new EventEmitter(), {
    preparation: {
      verdict: 'ready',
      steps: [],
      remediations: [],
      limitations: [],
      recommendations: [],
    },
    close: vi.fn(async () => {}),
  })
}

const ASSESSMENT_TIMEOUT_MS = 30_000

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ModemPool assessment-timeout recovery (FLT-C2)', () => {
  let pool: ModemPool
  let observer: EventEmitter
  let stages: string[]

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.mocked(provision).mockResolvedValue({
      transport: {},
      driver: {},
      profile: { name: 'test', vendorId: VENDOR_ID },
    })
    vi.spyOn(Modem, 'connectFromPrepared').mockResolvedValue(makeReadyModem())

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
