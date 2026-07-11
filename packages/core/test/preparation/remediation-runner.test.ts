import { describe, expect, it } from 'vitest'

import { noopLogger } from '../../src/logger.js'
import {
  applyRemediations,
  DEFAULT_REMEDIATION_POLICY,
} from '../../src/preparation/remediation-runner.js'
import type { Recoverability, Remediation } from '../../src/preparation/types.js'

interface FakeSpec {
  recoverability?: Recoverability
  needed?: boolean
  onIsNeeded?: () => Promise<boolean>
  onApply?: () => Promise<void>
  onVerify?: () => Promise<boolean>
}

function fakeRemediation(spec: FakeSpec = {}): {
  remediation: Remediation
  applied: () => boolean
} {
  let didApply = false
  const remediation: Remediation = {
    id: 'test-fix',
    scope: 'test',
    description: 'test remediation',
    recoverability: spec.recoverability ?? 'software-reversible',
    isNeeded: spec.onIsNeeded ?? (() => Promise.resolve(spec.needed ?? true)),
    apply:
      spec.onApply ??
      (() => {
        didApply = true
        return Promise.resolve()
      }),
    verify: spec.onVerify ?? (() => Promise.resolve(true)),
  }
  return { remediation, applied: () => didApply }
}

function run(remediation: Remediation) {
  return applyRemediations({}, [remediation], noopLogger)
}

describe('applyRemediations', () => {
  it('reports not-needed and does not apply when isNeeded is false', async () => {
    const { remediation, applied } = fakeRemediation({ needed: false })

    const [record] = await run(remediation)

    expect(record?.outcome.status).toBe('not-needed')
    expect(applied()).toBe(false)
  })

  it('applies and verifies a needed software-reversible fix', async () => {
    const { remediation, applied } = fakeRemediation({ needed: true })

    const [record] = await run(remediation)

    expect(record?.outcome).toEqual({ status: 'applied', verified: true })
    expect(applied()).toBe(true)
  })

  it('skips a needed fix whose recoverability is not in the policy', async () => {
    const { remediation, applied } = fakeRemediation({
      needed: true,
      recoverability: 'software-persistent',
    })

    const [record] = await run(remediation)

    expect(record?.outcome.status).toBe('skipped')
    expect(applied()).toBe(false)
  })

  it('reports failed when apply throws', async () => {
    const { remediation } = fakeRemediation({
      needed: true,
      onApply: () => Promise.reject(new Error('sysfs write denied')),
    })

    const [record] = await run(remediation)

    expect(record?.outcome).toEqual({ status: 'failed', error: 'apply failed: sysfs write denied' })
  })

  it('reports applied-but-unverified when verify throws', async () => {
    const { remediation } = fakeRemediation({
      needed: true,
      onVerify: () => Promise.reject(new Error('read timeout')),
    })

    const [record] = await run(remediation)

    expect(record?.outcome.status).toBe('applied')
    if (record?.outcome.status === 'applied') {
      expect(record.outcome.verified).toBe(false)
    }
  })

  it('reports applied-but-unverified when verify returns false', async () => {
    const { remediation } = fakeRemediation({
      needed: true,
      onVerify: () => Promise.resolve(false),
    })

    const [record] = await run(remediation)

    expect(record?.outcome).toEqual({ status: 'applied', verified: false })
  })

  it('reports failed when isNeeded throws, without applying', async () => {
    const { remediation, applied } = fakeRemediation({
      onIsNeeded: () => Promise.reject(new Error('adb offline')),
    })

    const [record] = await run(remediation)

    expect(record?.outcome.status).toBe('failed')
    expect(applied()).toBe(false)
  })

  it('never auto-applies manual-hardware fixes under the default policy', () => {
    expect(DEFAULT_REMEDIATION_POLICY.autoApply).toEqual(['software-reversible'])
  })

  it('runs remediations sequentially in declared order', async () => {
    const order: string[] = []
    const make = (id: string): Remediation => ({
      id,
      scope: 'test',
      description: id,
      recoverability: 'software-reversible',
      isNeeded: () => Promise.resolve(true),
      apply: () => {
        order.push(id)
        return Promise.resolve()
      },
      verify: () => Promise.resolve(true),
    })

    await applyRemediations({}, [make('a'), make('b'), make('c')], noopLogger)

    expect(order).toEqual(['a', 'b', 'c'])
  })
})
