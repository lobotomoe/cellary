/**
 * State graph composition and pathfinding.
 *
 * compose() merges multiple graph layers into a single navigable graph.
 * findPath() uses Dijkstra's algorithm to find the cheapest transition
 * sequence between two states.
 */

import type {
  ComposedStateGraph,
  PathResult,
  StateEdge,
  StateGraphLayer,
  StateNode,
} from './types.js'

// -- Composition --------------------------------------------------------------

/**
 * Compose multiple graph layers into a single navigable graph.
 *
 * Layers are applied in order (generic first, specific last).
 * Later layers can:
 * - Add new states (with optional `refines` pointing to a parent state)
 * - Add new transitions
 * - Override transitions between the same (from, to) pair
 *
 * Throws if:
 * - A state's `refines` target doesn't exist in the composed graph
 * - Duplicate state ids within the same layer
 */
export function compose(...layers: readonly StateGraphLayer[]): ComposedStateGraph {
  const nodes = new Map<string, StateNode>()
  const edgeMap = new Map<string, StateEdge>() // keyed by "from->to"
  const adjacency = new Map<string, StateEdge[]>()

  for (const layer of layers) {
    // Add nodes
    for (const node of layer.nodes) {
      if (nodes.has(node.id)) {
        // Later layer overrides earlier definition (allows specialization)
        nodes.set(node.id, node)
      } else {
        nodes.set(node.id, node)
      }
      // Ensure adjacency entry exists
      if (!adjacency.has(node.id)) {
        adjacency.set(node.id, [])
      }
    }

    // Add edges (later layers override same from->to pairs)
    for (const edge of layer.edges) {
      const key = `${edge.from}->${edge.to}`
      edgeMap.set(key, edge)
    }
  }

  // Validate refines references
  for (const [id, node] of nodes) {
    if (node.refines !== undefined && !nodes.has(node.refines)) {
      throw new Error(
        `State '${id}' refines '${node.refines}' which does not exist in the composed graph`,
      )
    }
  }

  // Validate edge endpoints exist
  for (const edge of edgeMap.values()) {
    if (!nodes.has(edge.from)) {
      throw new Error(
        `Edge '${edge.from}->${edge.to}' references unknown source state '${edge.from}'`,
      )
    }
    if (!nodes.has(edge.to)) {
      throw new Error(
        `Edge '${edge.from}->${edge.to}' references unknown target state '${edge.to}'`,
      )
    }
  }

  // Build adjacency list from validated edges
  for (const edge of edgeMap.values()) {
    const list = adjacency.get(edge.from)
    if (list !== undefined) {
      list.push(edge)
    } else {
      adjacency.set(edge.from, [edge])
    }
  }

  // Freeze adjacency lists
  const frozenAdjacency = new Map<string, readonly StateEdge[]>()
  for (const [id, edges] of adjacency) {
    frozenAdjacency.set(id, edges)
  }

  return { layers, nodes, adjacency: frozenAdjacency }
}

// -- Pathfinding --------------------------------------------------------------

/**
 * Find the cheapest path between two states using Dijkstra's algorithm.
 *
 * Returns undefined if no path exists. Manual transitions are excluded
 * by default unless `includeManual` is true.
 */
export function findPath(
  graph: ComposedStateGraph,
  from: string,
  to: string,
  options?: { readonly includeManual?: boolean },
): PathResult | undefined {
  const includeManual = options?.includeManual ?? false

  if (!graph.nodes.has(from)) return undefined
  if (!graph.nodes.has(to)) return undefined
  if (from === to) return { edges: [], totalCost: 0, hasManualStep: false }

  // Also accept if `from` refines `to` (we're already in a more specific version of the target)
  const fromNode = graph.nodes.get(from)
  if (fromNode !== undefined && isRefinementOf(graph, from, to)) {
    return { edges: [], totalCost: 0, hasManualStep: false }
  }

  // Dijkstra
  const dist = new Map<string, number>()
  const prev = new Map<string, { node: string; edge: StateEdge }>()
  const visited = new Set<string>()

  dist.set(from, 0)

  // Simple priority queue (array-based, sufficient for small graphs)
  const queue: string[] = [from]

  while (queue.length > 0) {
    // Find node with minimum distance
    let minIdx = 0
    let minDist = dist.get(queue[0] ?? '') ?? Infinity
    for (let i = 1; i < queue.length; i++) {
      const d = dist.get(queue[i] ?? '') ?? Infinity
      if (d < minDist) {
        minDist = d
        minIdx = i
      }
    }

    const current = queue[minIdx]
    if (current === undefined) break
    queue.splice(minIdx, 1)

    if (visited.has(current)) continue
    visited.add(current)

    if (current === to) break

    const edges = graph.adjacency.get(current) ?? []
    for (const edge of edges) {
      if (!includeManual && edge.manual) continue
      if (visited.has(edge.to)) continue

      const newDist = (dist.get(current) ?? Infinity) + edge.cost
      const currentDist = dist.get(edge.to) ?? Infinity

      if (newDist < currentDist) {
        dist.set(edge.to, newDist)
        prev.set(edge.to, { node: current, edge })
        queue.push(edge.to)
      }
    }
  }

  // Reconstruct path
  if (!prev.has(to)) {
    // No direct path found. Check if `to` is a parent of any reachable state.
    // E.g. if we can reach 'hilink_at' and target is 'modem', that's a match
    // since 'hilink_at' refines 'modem'.
    const reachable = findReachableRefinement(graph, to, prev)
    if (reachable !== undefined) {
      return reconstructPath(prev, reachable)
    }
    return undefined
  }

  return reconstructPath(prev, to)
}

/**
 * Find the best terminal state in the graph.
 *
 * Returns the most specific terminal state reachable from `from`.
 * "Most specific" means: deepest in the refinement chain.
 */
export function findBestTarget(
  graph: ComposedStateGraph,
  from: string,
  options?: { readonly includeManual?: boolean },
): string | undefined {
  let bestTarget: string | undefined
  let bestCost = Infinity
  let bestDepth = -1

  for (const [id, node] of graph.nodes) {
    if (!node.terminal) continue

    const path = findPath(graph, from, id, options)
    if (path === undefined) continue

    const depth = refinementDepth(graph, id)
    // Prefer deeper (more specific) terminal states, then cheaper paths
    if (depth > bestDepth || (depth === bestDepth && path.totalCost < bestCost)) {
      bestTarget = id
      bestCost = path.totalCost
      bestDepth = depth
    }
  }

  return bestTarget
}

// -- Refinement utilities -----------------------------------------------------

/** Check if stateId is a refinement of (or equal to) targetId. */
export function isRefinementOf(
  graph: ComposedStateGraph,
  stateId: string,
  targetId: string,
): boolean {
  if (stateId === targetId) return true

  let current = stateId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    // cycle guard: loop exits once a state is revisited
    seen.add(current)

    const node = graph.nodes.get(current)
    if (node?.refines === undefined) break
    if (node.refines === targetId) return true
    current = node.refines
  }

  return false
}

/** How deep is this state in the refinement chain? Root states = 0. */
function refinementDepth(graph: ComposedStateGraph, stateId: string): number {
  let depth = 0
  let current = stateId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    // cycle guard: loop exits once a state is revisited
    seen.add(current)

    const node = graph.nodes.get(current)
    if (node?.refines === undefined) break
    depth++
    current = node.refines
  }
  return depth
}

/** Find the cheapest reachable state that refines the target. */
function findReachableRefinement(
  graph: ComposedStateGraph,
  targetId: string,
  prev: ReadonlyMap<string, { node: string; edge: StateEdge }>,
): string | undefined {
  let bestId: string | undefined
  let bestCost = Infinity

  for (const [id] of prev) {
    if (isRefinementOf(graph, id, targetId)) {
      const path = reconstructPath(prev, id)
      if (path !== undefined && path.totalCost < bestCost) {
        bestId = id
        bestCost = path.totalCost
      }
    }
  }

  return bestId
}

/** Reconstruct a path from Dijkstra's predecessor map. */
function reconstructPath(
  prev: ReadonlyMap<string, { node: string; edge: StateEdge }>,
  to: string,
): PathResult | undefined {
  const edges: StateEdge[] = []
  let current = to
  let totalCost = 0
  let hasManualStep = false

  while (prev.has(current)) {
    const entry = prev.get(current)
    if (entry === undefined) break
    edges.unshift(entry.edge)
    totalCost += entry.edge.cost
    if (entry.edge.manual) hasManualStep = true
    current = entry.node
  }

  return { edges, totalCost, hasManualStep }
}
