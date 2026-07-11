import { describe, expect, it } from 'vitest'
import { GENERIC_LAYER } from '../../src/lifecycle/generic-states.js'
import { compose, findBestTarget, findPath, isRefinementOf } from '../../src/lifecycle/graph.js'
import type { StateGraphLayer } from '../../src/lifecycle/types.js'
import { HUAWEI_LAYER } from '../../src/vendor/huawei/lifecycle.js'
import { BALONG_LAYER } from '../../src/vendor/huawei/platforms/balong/lifecycle.js'
import { E3372_LAYER } from '../../src/vendor/huawei/platforms/balong/models/e3372/lifecycle.js'
import { E8372_LAYER } from '../../src/vendor/huawei/platforms/balong/models/e8372/lifecycle.js'

// -- Test fixtures ------------------------------------------------------------

const SIMPLE_LAYER_A: StateGraphLayer = {
  name: 'layer-a',
  nodes: [
    { id: 'a', label: 'State A', severity: 'normal' },
    { id: 'b', label: 'State B', severity: 'normal', terminal: true },
    { id: 'c', label: 'State C', severity: 'normal' },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'A->B', cost: 1, reversible: true, manual: false },
    { from: 'a', to: 'c', label: 'A->C', cost: 3, reversible: false, manual: false },
    { from: 'c', to: 'b', label: 'C->B', cost: 1, reversible: false, manual: false },
  ],
}

const REFINEMENT_LAYER: StateGraphLayer = {
  name: 'refinement',
  nodes: [
    { id: 'b1', label: 'B variant 1', severity: 'normal', refines: 'b', terminal: true },
    { id: 'b2', label: 'B variant 2', severity: 'degraded', refines: 'b', terminal: true },
  ],
  edges: [
    { from: 'a', to: 'b1', label: 'A->B1', cost: 2, reversible: false, manual: false },
    { from: 'a', to: 'b2', label: 'A->B2', cost: 5, reversible: false, manual: false },
    { from: 'b2', to: 'c', label: 'B2->C', cost: 1, reversible: false, manual: false },
  ],
}

const MANUAL_LAYER: StateGraphLayer = {
  name: 'manual',
  nodes: [
    { id: 'x', label: 'State X', severity: 'normal' },
    { id: 'y', label: 'State Y', severity: 'normal', terminal: true },
  ],
  edges: [
    { from: 'x', to: 'y', label: 'X->Y (manual)', cost: 100, reversible: true, manual: true },
  ],
}

// -- compose() ----------------------------------------------------------------

describe('compose()', () => {
  it('composes a single layer', () => {
    const graph = compose(SIMPLE_LAYER_A)
    expect(graph.layers).toHaveLength(1)
    expect(graph.nodes.size).toBe(3)
    expect(graph.adjacency.get('a')).toHaveLength(2)
    expect(graph.adjacency.get('c')).toHaveLength(1)
  })

  it('composes multiple layers', () => {
    const graph = compose(SIMPLE_LAYER_A, REFINEMENT_LAYER)
    expect(graph.nodes.size).toBe(5) // a, b, c, b1, b2
    expect(graph.adjacency.get('a')).toHaveLength(4) // b, c, b1, b2
  })

  it('later layer overrides edges with same from->to', () => {
    const override: StateGraphLayer = {
      name: 'override',
      nodes: [],
      edges: [
        { from: 'a', to: 'b', label: 'A->B (cheaper)', cost: 0, reversible: true, manual: false },
      ],
    }
    const graph = compose(SIMPLE_LAYER_A, override)
    const aEdges = graph.adjacency.get('a') ?? []
    const abEdge = aEdges.find((e) => e.to === 'b')
    expect(abEdge?.cost).toBe(0)
    expect(abEdge?.label).toBe('A->B (cheaper)')
  })

  it('throws on broken refines reference', () => {
    const broken: StateGraphLayer = {
      name: 'broken',
      nodes: [{ id: 'orphan', label: 'Orphan', severity: 'normal', refines: 'nonexistent' }],
      edges: [],
    }
    expect(() => compose(SIMPLE_LAYER_A, broken)).toThrow("refines 'nonexistent'")
  })

  it('throws on edge referencing unknown source state', () => {
    const broken: StateGraphLayer = {
      name: 'broken',
      nodes: [],
      edges: [{ from: 'ghost', to: 'a', label: 'bad', cost: 1, reversible: false, manual: false }],
    }
    expect(() => compose(SIMPLE_LAYER_A, broken)).toThrow("unknown source state 'ghost'")
  })

  it('throws on edge referencing unknown target state', () => {
    const broken: StateGraphLayer = {
      name: 'broken',
      nodes: [],
      edges: [{ from: 'a', to: 'ghost', label: 'bad', cost: 1, reversible: false, manual: false }],
    }
    expect(() => compose(SIMPLE_LAYER_A, broken)).toThrow("unknown target state 'ghost'")
  })

  it('composes generic + huawei layers without errors', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER)
    expect(graph.nodes.has('hilink_at')).toBe(true)
    expect(graph.nodes.has('hilink_only')).toBe(true)
    expect(graph.nodes.has('stick')).toBe(true)
    expect(graph.nodes.get('hilink_at')?.refines).toBe('modem')
  })

  it('composes generic + huawei + balong layers', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER)
    expect(graph.nodes.has('balong_download')).toBe(true)
    expect(graph.nodes.get('balong_download')?.refines).toBe('download')
  })

  it('composes all layers (generic + huawei + balong + e8372) without errors', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, E8372_LAYER)
    // E8372 adds storage -> hilink_only edge
    const storageEdges = graph.adjacency.get('storage') ?? []
    const hilinkOnlyEdge = storageEdges.find((e) => e.to === 'hilink_only')
    expect(hilinkOnlyEdge).toBeDefined()
  })
})

// -- findPath() ---------------------------------------------------------------

describe('findPath()', () => {
  it('returns empty path for same source and target', () => {
    const graph = compose(SIMPLE_LAYER_A)
    const path = findPath(graph, 'a', 'a')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(0)
    expect(path?.totalCost).toBe(0)
  })

  it('finds direct path', () => {
    const graph = compose(SIMPLE_LAYER_A)
    const path = findPath(graph, 'a', 'b')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(1)
    expect(path?.totalCost).toBe(1)
    expect(path?.edges[0]?.from).toBe('a')
    expect(path?.edges[0]?.to).toBe('b')
  })

  it('finds cheapest path when multiple routes exist', () => {
    const graph = compose(SIMPLE_LAYER_A)
    // a->b (cost 1) vs a->c->b (cost 3+1=4)
    const path = findPath(graph, 'a', 'b')
    expect(path?.totalCost).toBe(1)
    expect(path?.edges).toHaveLength(1)
  })

  it('finds multi-hop path', () => {
    // Remove direct a->b, force a->c->b
    const noDirectLayer: StateGraphLayer = {
      name: 'no-direct',
      nodes: [
        { id: 'a', label: 'A', severity: 'normal' },
        { id: 'b', label: 'B', severity: 'normal' },
        { id: 'c', label: 'C', severity: 'normal' },
      ],
      edges: [
        { from: 'a', to: 'c', label: 'A->C', cost: 2, reversible: false, manual: false },
        { from: 'c', to: 'b', label: 'C->B', cost: 3, reversible: false, manual: false },
      ],
    }
    const graph = compose(noDirectLayer)
    const path = findPath(graph, 'a', 'b')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(2)
    expect(path?.totalCost).toBe(5)
  })

  it('returns undefined for unreachable target', () => {
    const graph = compose(SIMPLE_LAYER_A)
    // No edges from b to a
    const path = findPath(graph, 'b', 'a')
    expect(path).toBeUndefined()
  })

  it('returns undefined for unknown source', () => {
    const graph = compose(SIMPLE_LAYER_A)
    expect(findPath(graph, 'unknown', 'b')).toBeUndefined()
  })

  it('returns undefined for unknown target', () => {
    const graph = compose(SIMPLE_LAYER_A)
    expect(findPath(graph, 'a', 'unknown')).toBeUndefined()
  })

  it('excludes manual transitions by default', () => {
    const graph = compose(SIMPLE_LAYER_A, MANUAL_LAYER)
    const path = findPath(graph, 'x', 'y')
    expect(path).toBeUndefined()
  })

  it('includes manual transitions when requested', () => {
    const graph = compose(SIMPLE_LAYER_A, MANUAL_LAYER)
    const path = findPath(graph, 'x', 'y', { includeManual: true })
    expect(path).toBeDefined()
    expect(path?.hasManualStep).toBe(true)
    expect(path?.totalCost).toBe(100)
  })

  it('marks hasManualStep correctly', () => {
    const graph = compose(SIMPLE_LAYER_A)
    const path = findPath(graph, 'a', 'b')
    expect(path?.hasManualStep).toBe(false)
  })

  // Refinement-aware pathfinding

  it('treats refinement as already-at-target', () => {
    const graph = compose(SIMPLE_LAYER_A, REFINEMENT_LAYER)
    // b1 refines b, so if we're at b1 and target is b, we're already there
    const path = findPath(graph, 'b1', 'b')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(0)
    expect(path?.totalCost).toBe(0)
  })

  it('finds path to parent state via reachable refinement', () => {
    // If target is 'b' but only 'b1' (refines 'b') is reachable
    const graph = compose(SIMPLE_LAYER_A, REFINEMENT_LAYER)
    const path = findPath(graph, 'a', 'b')
    // Direct a->b (cost 1) should still be found
    expect(path).toBeDefined()
    expect(path?.totalCost).toBe(1)
  })

  // Real-world: Huawei E8372 navigation

  it('finds path from storage to hilink_at in Huawei graph', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER)
    const path = findPath(graph, 'storage', 'hilink_at')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(1)
    expect(path?.edges[0]?.label).toContain('vendor control')
    expect(path?.totalCost).toBe(5)
    expect(path?.hasManualStep).toBe(false)
  })

  it('finds path from hilink_only to hilink_at via storage', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER)
    const path = findPath(graph, 'hilink_only', 'hilink_at')
    expect(path).toBeDefined()
    // hilink_only -> storage (cost 10) -> hilink_at (cost 5)
    expect(path?.edges).toHaveLength(2)
    expect(path?.totalCost).toBe(15)
  })

  it('finds path from storage to modem (generic) via hilink_at refinement', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER)
    // 'modem' is the generic target, 'hilink_at' refines it
    // The generic edge storage->modem (cost 5) and huawei edge storage->hilink_at (cost 5) both exist
    const path = findPath(graph, 'storage', 'modem')
    expect(path).toBeDefined()
    expect(path?.totalCost).toBe(5)
  })
})

// -- isRefinementOf() ---------------------------------------------------------

describe('isRefinementOf()', () => {
  const graph = compose(SIMPLE_LAYER_A, REFINEMENT_LAYER)

  it('returns true for same state', () => {
    expect(isRefinementOf(graph, 'a', 'a')).toBe(true)
  })

  it('returns true for direct refinement', () => {
    expect(isRefinementOf(graph, 'b1', 'b')).toBe(true)
    expect(isRefinementOf(graph, 'b2', 'b')).toBe(true)
  })

  it('returns false for non-refinement', () => {
    expect(isRefinementOf(graph, 'a', 'b')).toBe(false)
    expect(isRefinementOf(graph, 'b', 'b1')).toBe(false) // parent is not refinement of child
  })

  it('works with Huawei states', () => {
    const huaweiGraph = compose(GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER)
    expect(isRefinementOf(huaweiGraph, 'hilink_at', 'modem')).toBe(true)
    expect(isRefinementOf(huaweiGraph, 'hilink_only', 'modem')).toBe(true)
    expect(isRefinementOf(huaweiGraph, 'stick', 'modem')).toBe(true)
    expect(isRefinementOf(huaweiGraph, 'balong_download', 'download')).toBe(true)
    expect(isRefinementOf(huaweiGraph, 'hilink_at', 'storage')).toBe(false)
  })
})

// -- findBestTarget() ---------------------------------------------------------

describe('findBestTarget()', () => {
  it('finds the only terminal state', () => {
    const graph = compose(SIMPLE_LAYER_A)
    const target = findBestTarget(graph, 'a')
    expect(target).toBe('b')
  })

  it('prefers more specific (refined) terminal states', () => {
    const graph = compose(SIMPLE_LAYER_A, REFINEMENT_LAYER)
    // b (terminal, depth 0), b1 (terminal, depth 1), b2 (terminal, depth 1)
    // b1 is cheaper (cost 2) than b2 (cost 5), both deeper than b (cost 1)
    const target = findBestTarget(graph, 'a')
    expect(target).toBe('b1')
  })

  it('returns undefined when no terminal state is reachable', () => {
    const noTerminal: StateGraphLayer = {
      name: 'no-terminal',
      nodes: [
        { id: 'p', label: 'P', severity: 'normal' },
        { id: 'q', label: 'Q', severity: 'normal' },
      ],
      edges: [{ from: 'p', to: 'q', label: 'P->Q', cost: 1, reversible: false, manual: false }],
    }
    const graph = compose(noTerminal)
    expect(findBestTarget(graph, 'p')).toBeUndefined()
  })

  it('finds best target in Huawei graph from storage', () => {
    const graph = compose(GENERIC_LAYER, HUAWEI_LAYER)
    // hilink_at and stick both refine modem (depth 1), modem is depth 0
    // storage -> hilink_at (cost 5), storage -> stick (cost 5)
    // Both are equal depth and cost, first one found wins
    const target = findBestTarget(graph, 'storage')
    expect(target).toBeDefined()
    // Should be one of the Huawei terminal states (deeper than generic 'modem')
    const node = graph.nodes.get(target ?? '')
    expect(node?.terminal).toBe(true)
    expect(node?.refines).toBe('modem')
  })
})

// -- Composition with all E8372 layers ----------------------------------------

describe('E8372 composed graph', () => {
  const graph = compose(GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, E8372_LAYER)

  it('has all expected states', () => {
    const expectedStates = [
      'absent',
      'storage',
      'modem',
      'download',
      'emergency',
      'hilink_only',
      'hilink_at',
      'stick',
      'balong_download',
    ]
    for (const id of expectedStates) {
      expect(graph.nodes.has(id)).toBe(true)
    }
  })

  it('has storage -> hilink_only edge from E8372 layer', () => {
    const storageEdges = graph.adjacency.get('storage') ?? []
    const toHilinkOnly = storageEdges.find((e) => e.to === 'hilink_only')
    expect(toHilinkOnly).toBeDefined()
    expect(toHilinkOnly?.label).toContain('U2DIAG=0')
  })

  it('can navigate from hilink_only to hilink_at', () => {
    const path = findPath(graph, 'hilink_only', 'hilink_at')
    expect(path).toBeDefined()
    expect(path?.hasManualStep).toBe(false)
  })
})

describe('E3372 composed graph', () => {
  const graph = compose(GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, E3372_LAYER)

  it('can navigate from storage to stick mode', () => {
    const path = findPath(graph, 'storage', 'stick')
    expect(path).toBeDefined()
    expect(path?.edges).toHaveLength(1)
    expect(path?.totalCost).toBe(5)
  })

  it('can navigate from storage to modem (generic target)', () => {
    const path = findPath(graph, 'storage', 'modem')
    expect(path).toBeDefined()
    expect(path?.totalCost).toBe(5)
  })
})
