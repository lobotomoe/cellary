import { describe, expect, it } from 'vitest'
import { createProbe } from '../../src/lifecycle/detector.js'
import { compose } from '../../src/lifecycle/graph.js'
import { navigate } from '../../src/lifecycle/navigator.js'
import type {
  StateDetector,
  StateGraphLayer,
  TransitionAction,
  TransitionContext,
} from '../../src/lifecycle/types.js'

// -- Test graph ---------------------------------------------------------------

const TEST_LAYER: StateGraphLayer = {
  name: 'test',
  nodes: [
    { id: 'off', label: 'Off', severity: 'normal' },
    { id: 'storage', label: 'Storage', severity: 'degraded' },
    { id: 'modem', label: 'Modem', severity: 'normal', terminal: true },
    { id: 'modem_v2', label: 'Modem V2', severity: 'normal', refines: 'modem', terminal: true },
  ],
  edges: [
    {
      from: 'storage',
      to: 'modem',
      label: 'Mode switch',
      cost: 5,
      reversible: false,
      manual: false,
    },
    {
      from: 'storage',
      to: 'modem_v2',
      label: 'Mode switch V2',
      cost: 5,
      reversible: false,
      manual: false,
    },
    { from: 'off', to: 'storage', label: 'Plug in', cost: 100, reversible: true, manual: true },
    { from: 'modem', to: 'off', label: 'Unplug', cost: 100, reversible: true, manual: true },
  ],
}

const graph = compose(TEST_LAYER)

// -- Helpers ------------------------------------------------------------------

/** Create a detector that matches based on a mutable state variable. */
function createMutableDetector(layer: string): {
  detectors: StateDetector[]
  setState: (state: string) => void
} {
  let currentState = 'off'

  const states = ['off', 'storage', 'modem', 'modem_v2']
  const detectors: StateDetector[] = states.map((stateId) => ({
    stateId,
    layer,
    confidence: 'classified' as const,
    detect: async () => currentState === stateId,
  }))

  return {
    detectors,
    setState: (s: string) => {
      currentState = s
    },
  }
}

function createTrackingAction(
  from: string,
  to: string,
  sideEffect?: (ctx: TransitionContext) => void,
): TransitionAction {
  return {
    edgeKey: `${from}->${to}`,
    execute: async (ctx: TransitionContext) => {
      sideEffect?.(ctx)
    },
  }
}

// -- Tests --------------------------------------------------------------------

describe('navigate()', () => {
  it('returns ok when already at target', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('modem')
    const probe = createProbe({ vendorId: 1, productId: 1, present: true })

    const result = await navigate(graph, detectors, [], probe, 'modem')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('modem')
      expect(result.stepsExecuted).toBe(0)
    }
  })

  it('returns ok when at a refinement of target', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('modem_v2')
    const probe = createProbe({ vendorId: 1, productId: 1, present: true })

    const result = await navigate(graph, detectors, [], probe, 'modem')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('modem_v2')
    }
  })

  it('executes a single transition', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('storage')

    const executed: string[] = []
    const action = createTrackingAction('storage', 'modem', () => {
      executed.push('storage->modem')
      setState('modem')
    })

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    const result = await navigate(graph, detectors, [action], probe, 'modem')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('modem')
      expect(result.stepsExecuted).toBe(1)
    }
    expect(executed).toEqual(['storage->modem'])
  })

  it('replans when transition lands on unexpected state', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('storage')

    // First switch lands on modem_v2 (unexpected but acceptable refinement)
    const action = createTrackingAction('storage', 'modem', () => {
      setState('modem_v2') // Surprise! Landed on refinement
    })

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    const result = await navigate(graph, detectors, [action], probe, 'modem')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('modem_v2')
    }
  })

  it('fails when no path exists (manual excluded)', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('off')

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    const result = await navigate(graph, detectors, [], probe, 'modem')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('No path')
      expect(result.lastState).toBe('off')
    }
  })

  it('fails when no action registered for edge', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('storage')

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    // No actions registered
    const result = await navigate(graph, detectors, [], probe, 'modem')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('No action registered')
    }
  })

  it('fails when detection returns undefined', async () => {
    // No detectors match anything
    const detectors: StateDetector[] = []
    const probe = createProbe({ vendorId: 1, productId: 1, present: true })

    const result = await navigate(graph, detectors, [], probe, 'modem')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Could not detect')
    }
  })

  it('respects maxSteps limit', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('storage')

    // Action that never changes state (infinite loop scenario)
    const action = createTrackingAction('storage', 'modem', () => {
      // Intentionally NOT changing state -> will loop
    })

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    const result = await navigate(graph, detectors, [action], probe, 'modem', { maxSteps: 3 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('maximum steps')
    }
  })

  it('emits progress events', async () => {
    const { detectors, setState } = createMutableDetector('test')
    setState('storage')

    const action = createTrackingAction('storage', 'modem', () => {
      setState('modem')
    })

    const events: string[] = []
    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    await navigate(graph, detectors, [action], probe, 'modem', {
      onProgress: (event) => events.push(event.phase),
    })

    expect(events).toContain('detecting')
    expect(events).toContain('planning')
    expect(events).toContain('transitioning')
    expect(events).toContain('verifying')
  })

  it('multi-step navigation with re-detection', async () => {
    // Test a scenario where we need 2 transitions:
    // Build a graph: a -> b -> c (c is terminal)
    const multiLayer: StateGraphLayer = {
      name: 'multi',
      nodes: [
        { id: 'a', label: 'A', severity: 'normal' },
        { id: 'b', label: 'B', severity: 'normal' },
        { id: 'c', label: 'C', severity: 'normal', terminal: true },
      ],
      edges: [
        { from: 'a', to: 'b', label: 'A->B', cost: 1, reversible: false, manual: false },
        { from: 'b', to: 'c', label: 'B->C', cost: 1, reversible: false, manual: false },
      ],
    }
    const multiGraph = compose(multiLayer)

    let state = 'a'
    const detectors: StateDetector[] = ['a', 'b', 'c'].map((id) => ({
      stateId: id,
      layer: 'multi',
      confidence: 'classified' as const,
      detect: async () => state === id,
    }))

    const steps: string[] = []
    const actions: TransitionAction[] = [
      {
        edgeKey: 'a->b',
        execute: async () => {
          state = 'b'
          steps.push('a->b')
        },
      },
      {
        edgeKey: 'b->c',
        execute: async () => {
          state = 'c'
          steps.push('b->c')
        },
      },
    ]

    const probe = createProbe({ vendorId: 1, productId: 1, present: true })
    const result = await navigate(multiGraph, detectors, actions, probe, 'c')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('c')
      expect(result.stepsExecuted).toBe(2)
    }
    expect(steps).toEqual(['a->b', 'b->c'])
  })
})
