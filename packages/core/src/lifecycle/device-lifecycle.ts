/**
 * Per-device lifecycle manager.
 *
 * DeviceLifecycle is the user-facing API for device state management.
 * It bundles the composed graph, detectors, and actions into a single
 * object that tracks one physical device through its state transitions.
 *
 * Usage:
 *   const lifecycle = new DeviceLifecycle(huaweiLifecycle, probeFactory)
 *   const state = await lifecycle.detectState()
 *   const result = await lifecycle.navigateTo('hilink_at')
 *
 * The probe factory is called before each detection to get a fresh view
 * of the device's USB state (PID changes after mode switches).
 */

import type { Logger } from '../logger.js'
import { noopLogger } from '../logger.js'
import { detectState } from './detector.js'
import { compose } from './graph.js'
import type { NavigateOptions, NavigationResult, ProbeFactory } from './navigator.js'
import { navigate } from './navigator.js'
import type {
  ComposedStateGraph,
  DetectionResult,
  LifecycleDefinition,
  StateDetector,
  StateGraphLayer,
  TransitionAction,
} from './types.js'

// -- Options ------------------------------------------------------------------

export interface DeviceLifecycleOptions {
  /** Logger for structured output. */
  readonly logger?: Logger | undefined
  /**
   * Additional graph layers to compose on top of the definition's layers.
   * Use this to add model-specific layers (e.g. E8372_LAYER, E3372_LAYER).
   */
  readonly extraLayers?: readonly StateGraphLayer[] | undefined
  /**
   * Additional detectors beyond what the definition provides.
   */
  readonly extraDetectors?: readonly StateDetector[] | undefined
  /**
   * Additional or replacement actions.
   * Actions with the same edgeKey override definition actions.
   */
  readonly extraActions?: readonly TransitionAction[] | undefined
}

// -- DeviceLifecycle ----------------------------------------------------------

export class DeviceLifecycle {
  readonly graph: ComposedStateGraph
  private readonly _detectors: readonly StateDetector[]
  private readonly _actions: readonly TransitionAction[]
  private readonly _probeFactory: ProbeFactory
  private readonly _log: Logger

  constructor(
    definition: LifecycleDefinition,
    probeFactory: ProbeFactory,
    options?: DeviceLifecycleOptions,
  ) {
    const allLayers = [...definition.layers, ...(options?.extraLayers ?? [])]
    this.graph = compose(...allLayers)

    this._detectors = [...definition.detectors, ...(options?.extraDetectors ?? [])]
    this._probeFactory = probeFactory
    this._log = options?.logger ?? noopLogger

    // Merge actions: extra actions override definition actions by edgeKey
    const actionMap = new Map<string, TransitionAction>()
    for (const action of definition.actions) {
      actionMap.set(action.edgeKey, action)
    }
    for (const action of options?.extraActions ?? []) {
      actionMap.set(action.edgeKey, action)
    }
    this._actions = [...actionMap.values()]
  }

  /**
   * Detect the current state of the device.
   *
   * Creates a fresh probe, then runs detectors in specificity order.
   * Returns the most specific matching state id, or undefined if
   * the device is not recognized.
   */
  async detectState(): Promise<DetectionResult | undefined> {
    const probe = await this._probeFactory()
    return detectState(probe, this._detectors, this.graph.layers)
  }

  /**
   * Navigate the device to a target state.
   *
   * Detects current state, plans the cheapest path, and executes
   * transitions one by one with re-detection after each step.
   *
   * Returns a NavigationResult indicating success or failure.
   */
  async navigateTo(targetState: string, options?: NavigateOptions): Promise<NavigationResult> {
    const mergedOptions: NavigateOptions = {
      logger: options?.logger ?? this._log,
      ...options,
    }

    return navigate(
      this.graph,
      this._detectors,
      this._actions,
      this._probeFactory,
      targetState,
      mergedOptions,
    )
  }

  /**
   * All state ids in the composed graph.
   */
  get states(): readonly string[] {
    return [...this.graph.nodes.keys()]
  }

  /**
   * All terminal (target) state ids.
   */
  get terminalStates(): readonly string[] {
    const result: string[] = []
    for (const [id, node] of this.graph.nodes) {
      if (node.terminal) result.push(id)
    }
    return result
  }

  /**
   * All registered action edge keys.
   */
  get registeredActions(): readonly string[] {
    return this._actions.map((a) => a.edgeKey)
  }
}
