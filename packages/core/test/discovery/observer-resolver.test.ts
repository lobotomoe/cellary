import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeviceSessionSnapshot } from '../../src/discovery/observer-types.js'
import { huaweiResolver } from '../../src/vendor/huawei/resolver.js'
import { msm8916OemResolver } from '../../src/vendor/msm8916-oem/resolver.js'

// -- Helpers -----------------------------------------------------------------

const QUALCOMM_VID = 0x05c6
const HUAWEI_VID = 0x12d1

function makeSnapshot(overrides: Partial<DeviceSessionSnapshot>): DeviceSessionSnapshot {
  return {
    deviceId: '0:1-1',
    vendorId: 0,
    vendorName: 'Test',
    serialNumber: undefined,
    currentCycle: undefined,
    history: [],
    firstSeenAt: Date.now(),
    state: 'off-bus',
    completedCycleCount: 0,
    avgOnBusDurationMs: undefined,
    avgOffBusDurationMs: undefined,
    ...overrides,
  }
}

function makeCycle(pid: number, attachedAt: number, detachedAt: number | undefined) {
  return {
    pid,
    name: 'test',
    attachedAt,
    detachedAt,
    modem: undefined,
  }
}

// -- Qualcomm MiFi resolver --------------------------------------------------

describe('msm8916OemResolver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('detects EDL mode', () => {
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      vendorName: 'Qualcomm MiFi',
      state: 'on-bus',
      currentCycle: makeCycle(0x9008, Date.now() - 1_000, undefined),
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('edl-mode')
    expect(result.severity).toBe('critical')
  })

  it('detects thermal boot-loop after 2+ fast cycles', () => {
    const now = Date.now()
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      vendorName: 'Qualcomm MiFi',
      state: 'off-bus',
      completedCycleCount: 3,
      avgOnBusDurationMs: 8_000, // 8s average -- well under 15s threshold
      avgOffBusDurationMs: 18_000,
      history: [
        makeCycle(0x90b6, now - 60_000, now - 52_000),
        makeCycle(0x90b6, now - 86_000, now - 78_000),
        makeCycle(0x90b6, now - 112_000, now - 104_000),
      ],
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('thermal-boot-loop')
    expect(result.severity).toBe('critical')
    expect(result.recommendations.length).toBeGreaterThan(0)
    expect(result.estimatedRecoveryMs).toBe(18_000)
  })

  it('does not flag boot-loop with only 1 cycle', () => {
    const now = Date.now()
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      state: 'off-bus',
      completedCycleCount: 1,
      avgOnBusDurationMs: undefined,
      history: [makeCycle(0x90b6, now - 10_000, now - 2_000)],
    })

    const result = msm8916OemResolver.analyze(snapshot)
    // Should not be boot-loop
    expect(result?.state).not.toBe('thermal-boot-loop')
  })

  it('detects composition change (PID transition)', () => {
    const now = Date.now()
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0xf00e, now - 2_000, undefined),
      completedCycleCount: 1,
      history: [makeCycle(0x90b6, now - 30_000, now - 5_000)],
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('composition-change')
    expect(result.description).toContain('90b6')
    expect(result.description).toContain('f00e')
  })

  it('detects stable device after 30s+ on bus', () => {
    vi.setSystemTime(Date.now())
    const stableStart = Date.now() - 60_000 // on bus for 60s

    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x90b6, stableStart, undefined),
      completedCycleCount: 0,
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    // Could be stable or cold-start depending on timing
    // With 60s on bus and 0 completed cycles: stable wins (checked before cold-start)
    expect(result.state).toBe('stable')
  })

  it('detects cold start', () => {
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x90b6, Date.now() - 500, undefined),
      completedCycleCount: 0,
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('cold-start')
  })

  it('detects waiting state when off-bus with history', () => {
    const now = Date.now()
    const snapshot = makeSnapshot({
      vendorId: QUALCOMM_VID,
      state: 'off-bus',
      completedCycleCount: 1,
      history: [makeCycle(0x90b6, now - 40_000, now - 2_000)],
    })

    const result = msm8916OemResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('waiting')
  })
})

// -- Huawei resolver ---------------------------------------------------------

describe('huaweiResolver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('detects mode-switching (storage -> modem transition)', () => {
    const now = Date.now()
    // Storage PID just detached, modem PID appeared 2s later
    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      vendorName: 'Huawei',
      state: 'on-bus',
      currentCycle: makeCycle(0x1506, now - 500, undefined), // modem PID
      completedCycleCount: 1,
      history: [makeCycle(0x14fe, now - 5_000, now - 2_500)], // storage PID
    })

    const result = huaweiResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('mode-switching')
    expect(result.severity).toBe('normal')
  })

  it('detects stuck-storage after 30s+', () => {
    vi.setSystemTime(Date.now())
    const stuckStart = Date.now() - 45_000

    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x14fe, stuckStart, undefined), // storage PID
      completedCycleCount: 0,
    })

    const result = huaweiResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('stuck-storage')
    expect(result.severity).toBe('degraded')
  })

  it('detects storage-mode (just appeared, not stuck yet)', () => {
    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x14fe, Date.now() - 2_000, undefined), // storage PID
      completedCycleCount: 0,
    })

    const result = huaweiResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('storage-mode')
    expect(result.severity).toBe('normal')
  })

  it('detects stable modem mode after 30s+', () => {
    vi.setSystemTime(Date.now())
    const stableStart = Date.now() - 60_000

    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x1566, stableStart, undefined), // HiLink+AT PID
      completedCycleCount: 0,
    })

    const result = huaweiResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    // Stable wins over cold-start because it's checked first and on-bus > 30s
    expect(result.state).toBe('stable')
  })

  it('detects cold start for modem PID', () => {
    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x1566, Date.now() - 500, undefined),
      completedCycleCount: 0,
    })

    const result = huaweiResolver.analyze(snapshot)
    if (result === undefined) throw new Error('expected resolver to return a result')
    expect(result.state).toBe('cold-start')
  })

  it('does not detect mode-switch when previous was not storage', () => {
    const now = Date.now()
    const snapshot = makeSnapshot({
      vendorId: HUAWEI_VID,
      state: 'on-bus',
      currentCycle: makeCycle(0x1506, now - 500, undefined),
      completedCycleCount: 1,
      history: [makeCycle(0x1566, now - 10_000, now - 2_000)], // modem -> modem
    })

    const result = huaweiResolver.analyze(snapshot)
    // Should not be mode-switching
    expect(result?.state).not.toBe('mode-switching')
  })
})
