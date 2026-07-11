/**
 * State detection runtime.
 *
 * Given a set of StateDetector implementations and a DeviceProbe,
 * determines which state the device is currently in.
 *
 * Detection order follows layer specificity: more specific layers
 * are tried first (e.g. Huawei 'hilink_at' before generic 'modem').
 */

import type { DetectionResult, DeviceProbe, StateDetector, StateGraphLayer } from './types.js'

type ProbeMode = NonNullable<DeviceProbe['mode']>

const VALID_MODES: readonly string[] = [
  'storage',
  'modem-usb',
  'http',
  'serial',
  'download',
  'emergency',
]

function isProbeMode(value: string): value is ProbeMode {
  return VALID_MODES.some((m) => m === value)
}

/**
 * Detect the current state of a device.
 *
 * Tries detectors in reverse layer order (most specific first).
 * Returns the first matching state id and confidence, or undefined if no detector matches.
 */
export async function detectState(
  probe: DeviceProbe,
  detectors: readonly StateDetector[],
  layers: readonly StateGraphLayer[],
): Promise<DetectionResult | undefined> {
  // Build layer ordering: later layers (more specific) have higher priority
  const layerPriority = new Map<string, number>()
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    if (layer !== undefined) {
      layerPriority.set(layer.name, i)
    }
  }

  // Sort detectors: higher layer index first (most specific wins)
  const sorted = [...detectors].sort((a, b) => {
    const pa = layerPriority.get(a.layer) ?? 0
    const pb = layerPriority.get(b.layer) ?? 0
    return pb - pa
  })

  for (const detector of sorted) {
    const matches = await detector.detect(probe)
    if (matches) {
      return { stateId: detector.stateId, confidence: detector.confidence }
    }
  }

  return undefined
}

/**
 * Create a DeviceProbe from a simple snapshot.
 *
 * For use when you have raw USB device data and want to create
 * a probe object for detection. The httpProber function is called
 * lazily — only when a detector actually needs HTTP reachability info.
 */
export function createProbe(snapshot: {
  readonly vendorId: number
  readonly productId: number
  readonly present: boolean
  readonly mode?: DeviceProbe['mode']
  readonly httpUrl?: string
  readonly interfaces?: readonly {
    bInterfaceClass: number
    bInterfaceSubClass: number
    bInterfaceProtocol: number
  }[]
  readonly httpProber?: (url: string) => Promise<boolean>
}): DeviceProbe {
  return {
    vendorId: snapshot.vendorId,
    productId: snapshot.productId,
    present: snapshot.present,
    mode: snapshot.mode,
    httpUrl: snapshot.httpUrl,
    interfaces: snapshot.interfaces,
    probeHttp: snapshot.httpProber ?? (() => Promise.resolve(false)),
  }
}

/**
 * Create a DeviceProbe from a DiscoveredModem.
 *
 * Bridges the discovery layer to the lifecycle layer.
 */
export function probeFromDiscovered(
  modem: {
    readonly mode: string
    readonly vendorId: number
    readonly productId: number
  },
  httpProber?: (url: string) => Promise<boolean>,
): DeviceProbe {
  const httpUrl = 'url' in modem && typeof modem.url === 'string' ? modem.url : undefined
  return {
    vendorId: modem.vendorId,
    productId: modem.productId,
    present: true,
    mode: isProbeMode(modem.mode) ? modem.mode : undefined,
    httpUrl,
    probeHttp: httpProber ?? (() => Promise.resolve(false)),
  }
}
