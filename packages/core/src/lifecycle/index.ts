// Graph composition and pathfinding

// Detection runtime
export { createProbe, detectState, probeFromDiscovered } from './detector.js'
// Per-device lifecycle manager
export { DeviceLifecycle, type DeviceLifecycleOptions } from './device-lifecycle.js'
export { GENERIC_DETECTORS } from './generic-detectors.js'
// State definitions
export { GENERIC_LAYER } from './generic-states.js'
export { compose, findBestTarget, findPath, isRefinementOf } from './graph.js'
// Navigation runtime
export {
  type NavigateOptions,
  type NavigationProgress,
  type NavigationResult,
  navigate,
  type ProbeFactory,
} from './navigator.js'

// Types
export type {
  ComposedStateGraph,
  DetectionConfidence,
  DetectionResult,
  DeviceProbe,
  LifecycleDefinition,
  PathResult,
  StateDetector,
  StateEdge,
  StateGraphLayer,
  StateNode,
  StateSeverity,
  TransitionAction,
  TransitionContext,
  UsbInterfaceDescriptor,
} from './types.js'
