/**
 * Lifecycle navigator.
 *
 * Orchestrates the detect -> pathfind -> execute loop to drive a device
 * from its current state to a target state. The navigator:
 *
 * 1. Creates a fresh probe (re-scans USB for current device state)
 * 2. Detects the current state using registered detectors
 * 3. Finds the cheapest path to the target using the composed graph
 * 4. Executes ONE transition, then loops back to step 1
 *
 * The re-detection loop is key for robustness: real hardware doesn't
 * always land where you expect. The E8372 may land on hilink_only
 * instead of hilink_at depending on NV settings. The navigator
 * adapts and replans.
 */

import type { Logger } from '../logger.js'
import { noopLogger } from '../logger.js'
import { detectState } from './detector.js'
import { findPath } from './graph.js'
import type {
  ComposedStateGraph,
  DetectionConfidence,
  DeviceProbe,
  StateDetector,
  StateEdge,
  TransitionAction,
  TransitionContext,
} from './types.js'

// -- Types --------------------------------------------------------------------

/**
 * A function that creates a fresh DeviceProbe by scanning the USB bus.
 *
 * Called before each detection cycle so the probe reflects the device's
 * current state (PID may change after mode switches).
 */
export type ProbeFactory = () => Promise<DeviceProbe>

/** Progress event emitted during navigation. */
export interface NavigationProgress {
  /** What phase of navigation we're in. */
  readonly phase: 'detecting' | 'planning' | 'transitioning' | 'verifying'
  /** Current detected state (undefined during initial detection). */
  readonly currentState?: string | undefined
  /** Target state we're navigating to. */
  readonly targetState: string
  /** Current edge being executed, if in 'transitioning' phase. */
  readonly edge?: StateEdge | undefined
  /** Step number within the planned path (1-based). */
  readonly step?: number | undefined
  /** Total number of steps in the planned path. */
  readonly totalSteps?: number | undefined
  /** Human-readable message. */
  readonly message: string
}

/** Result of a navigation attempt. */
export type NavigationResult =
  | {
      readonly ok: true
      readonly finalState: string
      readonly confidence: DetectionConfidence
      readonly stepsExecuted: number
    }
  | { readonly ok: false; readonly error: string; readonly lastState?: string | undefined }

/** Options for navigate(). */
export interface NavigateOptions {
  /** Logger for structured output. */
  readonly logger?: Logger | undefined
  /** Progress callback for UI feedback. */
  readonly onProgress?: ((event: NavigationProgress) => void) | undefined
  /** Include manual (hardware intervention) transitions. Default: false. */
  readonly includeManual?: boolean | undefined
  /**
   * Maximum transitions to execute before giving up.
   * Prevents infinite loops from detection/transition bugs.
   * Default: 10.
   */
  readonly maxSteps?: number | undefined
}

// -- Navigator ----------------------------------------------------------------

const DEFAULT_MAX_STEPS = 10

/**
 * Navigate a device from its current state to a target state.
 *
 * Accepts either a static DeviceProbe or a ProbeFactory. When a factory
 * is provided, it's called before each detection cycle to get a fresh
 * probe reflecting the device's current USB state (critical after mode
 * switches that change the PID).
 */
export async function navigate(
  graph: ComposedStateGraph,
  detectors: readonly StateDetector[],
  actions: readonly TransitionAction[],
  probeOrFactory: DeviceProbe | ProbeFactory,
  targetState: string,
  options?: NavigateOptions,
): Promise<NavigationResult> {
  const log = options?.logger ?? noopLogger
  const onProgress = options?.onProgress
  const includeManual = options?.includeManual ?? false
  const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS

  const getProbe: ProbeFactory =
    typeof probeOrFactory === 'function' ? probeOrFactory : () => Promise.resolve(probeOrFactory)

  // Build action lookup
  const actionMap = new Map<string, TransitionAction>()
  for (const action of actions) {
    actionMap.set(action.edgeKey, action)
  }

  let stepsExecuted = 0

  // Detection -> planning -> execution loop
  while (stepsExecuted < maxSteps) {
    // 1. Get fresh probe and detect current state
    onProgress?.({
      phase: 'detecting',
      targetState,
      message: 'Detecting device state',
    })

    const probe = await getProbe()
    const detection = await detectState(probe, detectors, graph.layers)
    if (detection === undefined) {
      return {
        ok: false,
        error: 'Could not detect device state. Device may be disconnected or unrecognized.',
      }
    }

    const currentState = detection.stateId
    log.info('Detected state', {
      state: currentState,
      confidence: detection.confidence,
      target: targetState,
    })

    // 2. Check if we're already at the target (or a refinement of it)
    if (isAtTarget(graph, currentState, targetState)) {
      log.info('Already at target state', { state: currentState })
      return { ok: true, finalState: currentState, confidence: detection.confidence, stepsExecuted }
    }

    // 3. Plan path
    onProgress?.({
      phase: 'planning',
      currentState,
      targetState,
      message: `Planning path from ${currentState} to ${targetState}`,
    })

    const path = findPath(graph, currentState, targetState, { includeManual })
    if (path === undefined) {
      return {
        ok: false,
        error:
          `No path from '${currentState}' to '${targetState}'. ` +
          (includeManual
            ? 'No transitions exist between these states.'
            : 'Try with includeManual: true if manual steps are acceptable.'),
        lastState: currentState,
      }
    }

    if (path.edges.length === 0) {
      return { ok: true, finalState: currentState, confidence: detection.confidence, stepsExecuted }
    }

    // 4. Execute the FIRST transition only, then re-detect
    const edge = path.edges[0]
    if (edge === undefined) {
      return { ok: true, finalState: currentState, confidence: detection.confidence, stepsExecuted }
    }

    const edgeKey = `${edge.from}->${edge.to}`
    const action = actionMap.get(edgeKey)

    if (action === undefined) {
      return {
        ok: false,
        error:
          `No action registered for transition '${edgeKey}'. ` +
          `The lifecycle definition is missing an action for this edge.`,
        lastState: currentState,
      }
    }

    if (edge.manual) {
      return {
        ok: false,
        error: `Transition '${edgeKey}' requires manual intervention: ${edge.label}`,
        lastState: currentState,
      }
    }

    onProgress?.({
      phase: 'transitioning',
      currentState,
      targetState,
      edge,
      step: stepsExecuted + 1,
      totalSteps: path.edges.length + stepsExecuted,
      message: edge.label,
    })

    log.info('Executing transition', { from: edge.from, to: edge.to, label: edge.label })

    const context = probeToContext(probe, log)
    await action.execute(context)
    stepsExecuted++

    // 5. Verify (next loop iteration will re-detect)
    onProgress?.({
      phase: 'verifying',
      currentState: edge.to,
      targetState,
      message: `Verifying transition to ${edge.to}`,
    })
  }

  const finalProbe = await getProbe()
  const finalDetection = await detectState(finalProbe, detectors, graph.layers)
  return {
    ok: false,
    error: `Navigation exceeded maximum steps (${maxSteps}). Possible loop detected.`,
    lastState: finalDetection?.stateId,
  }
}

// -- Helpers ------------------------------------------------------------------

/** Check if currentState is the target or a refinement of the target. */
function isAtTarget(graph: ComposedStateGraph, currentState: string, targetState: string): boolean {
  if (currentState === targetState) return true

  let state = currentState
  const seen = new Set<string>()
  while (!seen.has(state)) {
    // cycle guard: loop exits once a state is revisited
    seen.add(state)
    const node = graph.nodes.get(state)
    if (node?.refines === undefined) break
    if (node.refines === targetState) return true
    state = node.refines
  }

  return false
}

/** Convert a DeviceProbe to a TransitionContext. */
function probeToContext(probe: DeviceProbe, logger: Logger): TransitionContext {
  return {
    vendorId: probe.vendorId,
    productId: probe.productId,
    logger,
  }
}
