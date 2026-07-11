/**
 * Device lifecycle state graph types.
 *
 * The lifecycle subsystem models device states as a directed graph.
 * States are nodes, transitions are edges. Graphs compose by refinement:
 * a vendor-specific state can refine a generic state, adding detail
 * without breaking the generic layer's understanding.
 *
 * Composition layers (most generic -> most specific):
 * 1. Generic  -- universal USB device states (absent, storage, modem, ...)
 * 2. Vendor   -- vendor-specific refinements (hilink_only, hilink_at, ...)
 * 3. Platform -- chipset-specific states (balong download mode, ...)
 * 4. Model    -- per-model quirks (e3372 voice mode, ...)
 *
 * More specific layers refine parent states via the `refines` field.
 * The navigator uses cost-weighted pathfinding to choose optimal transitions.
 */

// -- State nodes --------------------------------------------------------------

/** Severity of a device state. */
export type StateSeverity = 'normal' | 'degraded' | 'critical'

/** A state a device can be in. */
export interface StateNode {
  /** Unique identifier within the composed graph (e.g. 'storage', 'hilink_at'). */
  readonly id: string
  /** Human-readable label for display. */
  readonly label: string
  /** How concerning is this state? */
  readonly severity: StateSeverity
  /**
   * If this state refines a parent state, the parent's id.
   * Example: 'hilink_at' refines 'modem' (a Huawei-specific modem sub-state).
   */
  readonly refines?: string | undefined
  /**
   * Is this a desirable target state? Terminal states are what the user
   * typically wants (e.g. 'modem', 'hilink_at'). The navigator aims for
   * the most specific terminal state available.
   */
  readonly terminal?: boolean | undefined
  /**
   * Tags for categorization and filtering.
   * Examples: 'usable' (can run commands), 'flash' (firmware mode), 'recovery'.
   */
  readonly tags?: readonly string[] | undefined
}

// -- State edges (transitions) ------------------------------------------------

/** A possible transition between two states. */
export interface StateEdge {
  /** Source state id. */
  readonly from: string
  /** Target state id. */
  readonly to: string
  /** Human-readable description (e.g. 'USB vendor control transfer'). */
  readonly label: string
  /**
   * Cost metric for pathfinding. Lower = preferred.
   * Guidelines:
   *   1 = instant software command (AT command, HTTP request)
   *   5 = USB re-enumeration (seconds)
   *  10 = network-dependent operation
   *  50 = firmware flash
   * 100 = manual hardware intervention
   */
  readonly cost: number
  /** Can this transition be reversed by another transition? */
  readonly reversible: boolean
  /** Does this require physical hardware intervention (unplug, button press)? */
  readonly manual: boolean
}

// -- State graph layer --------------------------------------------------------

/** A single layer of a composable state graph. */
export interface StateGraphLayer {
  /** Layer name (e.g. 'generic', 'huawei', 'balong-v7r11', 'e3372h-153'). */
  readonly name: string
  /** States defined by this layer. */
  readonly nodes: readonly StateNode[]
  /** Transitions defined by this layer. */
  readonly edges: readonly StateEdge[]
}

// -- Composed graph -----------------------------------------------------------

/** A fully composed state graph from multiple layers. */
export interface ComposedStateGraph {
  /** All layers, from most generic to most specific. */
  readonly layers: readonly StateGraphLayer[]
  /** All nodes indexed by id. */
  readonly nodes: ReadonlyMap<string, StateNode>
  /** Adjacency list: node id -> outgoing edges. */
  readonly adjacency: ReadonlyMap<string, readonly StateEdge[]>
}

// -- Pathfinding result -------------------------------------------------------

/** Result of pathfinding between two states. */
export interface PathResult {
  /** Ordered sequence of edges from source to target. */
  readonly edges: readonly StateEdge[]
  /** Sum of edge costs along the path. */
  readonly totalCost: number
  /** Whether any edge in the path requires manual intervention. */
  readonly hasManualStep: boolean
}

// -- Detection ----------------------------------------------------------------

/**
 * How certain we are about the detected state.
 *
 * - identified: known vendor, known PID, known model (vendor-specific detectors)
 * - classified: known transport mode but no model-specific match (USB database hit)
 * - observed:   inferred from device behavior (interface classes, protocol probing)
 *
 * Higher confidence wins when multiple detectors could match. Within the same
 * confidence level, layer specificity (more specific first) breaks ties.
 */
export type DetectionConfidence = 'identified' | 'classified' | 'observed'

/** Result of state detection. */
export interface DetectionResult {
  /** Which state was detected. */
  readonly stateId: string
  /** How certain we are about this detection. */
  readonly confidence: DetectionConfidence
}

/**
 * A function that determines whether a device is currently in a specific state.
 *
 * Detectors are registered per state node. The lifecycle runtime calls them
 * in specificity order (most specific first) to determine the current state.
 */
export interface StateDetector {
  /** Which state this detector identifies. */
  readonly stateId: string
  /**
   * Layer name this detector belongs to. Used for ordering:
   * more specific layers are tried before generic ones.
   */
  readonly layer: string
  /**
   * Confidence level of this detector's identification.
   * Determines how much the system trusts the result.
   */
  readonly confidence: DetectionConfidence
  /** Probe the device and return true if it's in this state. */
  detect(probe: DeviceProbe): Promise<boolean>
}

/**
 * Observable device state for detection probes.
 *
 * Provides what detectors need to identify the current state without
 * coupling them to USB library internals.
 */
export interface DeviceProbe {
  /** USB vendor ID. */
  readonly vendorId: number
  /** USB product ID (current). */
  readonly productId: number
  /** Is this device currently visible on the USB bus? */
  readonly present: boolean
  /**
   * Classified mode from the USB database (classifyUsbDevice result).
   * Undefined when device is not present or not recognized.
   */
  readonly mode?: 'storage' | 'modem-usb' | 'http' | 'serial' | 'download' | 'emergency' | undefined
  /** HTTP endpoint URL, when the device is in vendor HTTP API mode. */
  readonly httpUrl?: string | undefined
  /** USB interface descriptors, when available. */
  readonly interfaces?: readonly UsbInterfaceDescriptor[] | undefined
  /** Probe HTTP endpoint reachability. */
  probeHttp(url: string): Promise<boolean>
}

/** Minimal USB interface descriptor for state detection. */
export interface UsbInterfaceDescriptor {
  readonly bInterfaceClass: number
  readonly bInterfaceSubClass: number
  readonly bInterfaceProtocol: number
}

// -- Navigation ---------------------------------------------------------------

/**
 * An executable action for a state transition.
 *
 * Each edge in the graph can have an associated action. The navigator
 * executes actions in sequence to drive the device to its target state.
 */
export interface TransitionAction {
  /** Edge identifier: "from->to". */
  readonly edgeKey: string
  /** Execute the transition. Throws on failure. */
  execute(context: TransitionContext): Promise<void>
}

/** Context provided to transition actions during execution. */
export interface TransitionContext {
  /** USB vendor ID. */
  readonly vendorId: number
  /** USB product ID at the start of the transition. */
  readonly productId: number
  /** Logger for transition progress. */
  readonly logger: Logger
}

// -- Lifecycle runtime --------------------------------------------------------

/**
 * A complete lifecycle definition for a device family.
 *
 * Bundles the static graph structure with the runtime behavior
 * (detectors and actions). Provided by vendor plugins.
 */
export interface LifecycleDefinition {
  /** Composable graph layers (ordered generic -> specific). */
  readonly layers: readonly StateGraphLayer[]
  /** State detectors (one per state node that can be detected). */
  readonly detectors: readonly StateDetector[]
  /** Transition actions (one per executable edge). */
  readonly actions: readonly TransitionAction[]
}

// Re-use Logger from the project
import type { Logger } from '../logger.js'
