import { describe, expect, it } from 'vitest'
import { createProbe } from '../../src/lifecycle/detector.js'
import { DeviceLifecycle } from '../../src/lifecycle/device-lifecycle.js'
import type {
  LifecycleDefinition,
  StateDetector,
  StateGraphLayer,
  TransitionAction,
  TransitionContext,
} from '../../src/lifecycle/types.js'

// -- Test graph ---------------------------------------------------------------

const BASE_LAYER: StateGraphLayer = {
  name: 'base',
  nodes: [
    { id: 'absent', label: 'Absent', severity: 'normal' },
    { id: 'storage', label: 'Storage', severity: 'degraded' },
    { id: 'modem', label: 'Modem', severity: 'normal', terminal: true },
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
    { from: 'absent', to: 'storage', label: 'Plug in', cost: 100, reversible: true, manual: true },
  ],
}

const VENDOR_LAYER: StateGraphLayer = {
  name: 'vendor',
  nodes: [
    {
      id: 'vendor_modem',
      label: 'Vendor Modem',
      severity: 'normal',
      refines: 'modem',
      terminal: true,
    },
  ],
  edges: [
    {
      from: 'storage',
      to: 'vendor_modem',
      label: 'Vendor switch',
      cost: 3,
      reversible: false,
      manual: false,
    },
  ],
}

// -- Helpers ------------------------------------------------------------------

function createMutableDetectors(layerName: string, states: string[]) {
  let currentState = 'absent'
  const detectors: StateDetector[] = states.map((stateId) => ({
    stateId,
    layer: layerName,
    confidence: 'classified' as const,
    detect: async () => currentState === stateId,
  }))
  return {
    detectors,
    setState: (s: string) => {
      currentState = s
    },
    getState: () => currentState,
  }
}

function trackingAction(from: string, to: string, sideEffect?: () => void): TransitionAction {
  return {
    edgeKey: `${from}->${to}`,
    async execute(_ctx: TransitionContext) {
      sideEffect?.()
    },
  }
}

// -- Tests --------------------------------------------------------------------

describe('DeviceLifecycle', () => {
  it('composes graph from definition layers', () => {
    const { detectors } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    expect(lifecycle.states).toContain('absent')
    expect(lifecycle.states).toContain('storage')
    expect(lifecycle.states).toContain('modem')
  })

  it('composes extra layers on top of definition', () => {
    const { detectors } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [],
    }

    const lifecycle = new DeviceLifecycle(
      definition,
      async () => createProbe({ vendorId: 1, productId: 1, present: true }),
      { extraLayers: [VENDOR_LAYER] },
    )

    expect(lifecycle.states).toContain('vendor_modem')
  })

  it('detects current state via probe factory', async () => {
    const { detectors, setState } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    setState('storage')

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true, mode: 'storage' }),
    )

    const result = await lifecycle.detectState()
    expect(result?.stateId).toBe('storage')
  })

  it('navigates to target state', async () => {
    const { detectors, setState } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    setState('storage')

    const action = trackingAction('storage', 'modem', () => setState('modem'))

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [action],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    const result = await lifecycle.navigateTo('modem')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalState).toBe('modem')
      expect(result.stepsExecuted).toBe(1)
    }
  })

  it('returns already-at-target when state matches', async () => {
    const { detectors, setState } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    setState('modem')

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    const result = await lifecycle.navigateTo('modem')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stepsExecuted).toBe(0)
    }
  })

  it('returns terminal states', () => {
    const { detectors } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    expect(lifecycle.terminalStates).toEqual(['modem'])
  })

  it('extra actions override definition actions', async () => {
    const { detectors, setState } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    setState('storage')

    const executed: string[] = []
    const originalAction = trackingAction('storage', 'modem', () => {
      executed.push('original')
      setState('modem')
    })
    const overrideAction = trackingAction('storage', 'modem', () => {
      executed.push('override')
      setState('modem')
    })

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [originalAction],
    }

    const lifecycle = new DeviceLifecycle(
      definition,
      async () => createProbe({ vendorId: 1, productId: 1, present: true }),
      { extraActions: [overrideAction] },
    )

    await lifecycle.navigateTo('modem')
    expect(executed).toEqual(['override'])
  })

  it('lists registered action edge keys', () => {
    const { detectors } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    const action = trackingAction('storage', 'modem')

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [action],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    expect(lifecycle.registeredActions).toContain('storage->modem')
  })

  it('calls probe factory fresh for each detection', async () => {
    let callCount = 0
    const { detectors, setState } = createMutableDetectors('base', ['absent', 'storage', 'modem'])
    setState('storage')

    const action = trackingAction('storage', 'modem', () => setState('modem'))

    const definition: LifecycleDefinition = {
      layers: [BASE_LAYER],
      detectors,
      actions: [action],
    }

    const lifecycle = new DeviceLifecycle(definition, async () => {
      callCount++
      return createProbe({ vendorId: 1, productId: 1, present: true })
    })

    await lifecycle.navigateTo('modem')
    // At least 2 calls: initial detection + post-transition verification
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('navigates with vendor layer (refinement-aware)', async () => {
    // Two-layer graph mimicking real setup: generic layer has modem,
    // vendor layer adds vendor_modem that refines modem.
    // Only the vendor edge exists (no direct storage->modem).
    const GENERIC: StateGraphLayer = {
      name: 'generic',
      nodes: [
        { id: 'storage', label: 'Storage', severity: 'degraded' },
        { id: 'modem', label: 'Modem', severity: 'normal', terminal: true },
      ],
      edges: [],
    }
    const VENDOR: StateGraphLayer = {
      name: 'vendor',
      nodes: [
        {
          id: 'vendor_modem',
          label: 'Vendor Modem',
          severity: 'normal',
          refines: 'modem',
          terminal: true,
        },
      ],
      edges: [
        {
          from: 'storage',
          to: 'vendor_modem',
          label: 'Vendor switch',
          cost: 3,
          reversible: false,
          manual: false,
        },
      ],
    }

    // Detectors with matching layer names for proper priority ordering
    const { detectors: genD, setState: setGen } = createMutableDetectors('generic', [
      'storage',
      'modem',
    ])
    const { detectors: venD, setState: setVen } = createMutableDetectors('vendor', ['vendor_modem'])
    setGen('storage')

    const action = trackingAction('storage', 'vendor_modem', () => {
      setGen('modem')
      setVen('vendor_modem')
    })

    const definition: LifecycleDefinition = {
      layers: [GENERIC, VENDOR],
      detectors: [...genD, ...venD],
      actions: [action],
    }

    const lifecycle = new DeviceLifecycle(definition, async () =>
      createProbe({ vendorId: 1, productId: 1, present: true }),
    )

    // Navigate to generic 'modem' -- pathfinder finds vendor_modem via refinement
    const result = await lifecycle.navigateTo('modem')
    expect(result.ok).toBe(true)
    if (result.ok) {
      // vendor_modem refines modem, detected with higher priority
      expect(result.finalState).toBe('vendor_modem')
    }
  })
})
