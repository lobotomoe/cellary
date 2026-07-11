/**
 * Generic state detectors.
 *
 * Two tiers of detection:
 *
 * 1. **Classified** (mode-based) — PID is in the USB database, `probe.mode`
 *    is set. Fast path, no I/O needed. Confidence: 'classified'.
 *
 * 2. **Observed** (interface-class-based) — PID is NOT in the database,
 *    `probe.mode` is undefined. Falls back to USB interface class analysis:
 *    CDC ACM (class 0x02/0x02) -> modem, Mass Storage (class 0x08) -> storage.
 *    This is the "analytical" path — the device tells us what it is through
 *    its interface descriptors. Confidence: 'observed'.
 *
 * Vendor-specific detectors (in vendor/ layers) use confidence: 'identified'.
 */

import type { DeviceProbe, StateDetector, UsbInterfaceDescriptor } from './types.js'

const LAYER = 'generic'

// -- USB interface class constants --------------------------------------------

/** USB Communications Device Class (CDC). */
const USB_CLASS_CDC = 0x02
/** CDC Abstract Control Model — standard AT modem interface. */
const USB_SUBCLASS_ACM = 0x02
/** USB Mass Storage class. */
const USB_CLASS_MASS_STORAGE = 0x08

// -- Classified detectors (mode-based, from USB database) ---------------------

/**
 * Device is not on the USB bus.
 * Matches when the probe reports the device as not present.
 */
const absentDetector: StateDetector = {
  stateId: 'absent',
  layer: LAYER,
  confidence: 'classified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    return !probe.present
  },
}

/**
 * Device is in storage / CD-ROM mode.
 * Detection relies on the `mode` field from classifyUsbDevice().
 */
const storageDetector: StateDetector = {
  stateId: 'storage',
  layer: LAYER,
  confidence: 'classified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present) return false
    return probe.mode === 'storage'
  },
}

/**
 * Device is in modem mode (generic — USB or HTTP).
 * Vendor layers refine this with more specific states.
 */
const modemDetector: StateDetector = {
  stateId: 'modem',
  layer: LAYER,
  confidence: 'classified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present) return false
    return probe.mode === 'modem-usb' || probe.mode === 'http' || probe.mode === 'serial'
  },
}

/** Device is in firmware download mode. */
const downloadDetector: StateDetector = {
  stateId: 'download',
  layer: LAYER,
  confidence: 'classified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present) return false
    return probe.mode === 'download'
  },
}

/** Device is in emergency / BootROM mode. */
const emergencyDetector: StateDetector = {
  stateId: 'emergency',
  layer: LAYER,
  confidence: 'classified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present) return false
    return probe.mode === 'emergency'
  },
}

// -- Observed detectors (interface-class-based, fallback) ---------------------

/** Check if any interface matches a given class (and optionally subclass). */
function hasInterfaceClass(
  interfaces: readonly UsbInterfaceDescriptor[] | undefined,
  classId: number,
  subClassId?: number,
): boolean {
  if (interfaces === undefined) return false
  return interfaces.some(
    (iface) =>
      iface.bInterfaceClass === classId &&
      (subClassId === undefined || iface.bInterfaceSubClass === subClassId),
  )
}

/**
 * Fallback modem detector: device has CDC ACM interface.
 *
 * Fires when `mode` is undefined (PID not in database) but the device
 * exposes a CDC ACM interface — the standard USB class for AT modems.
 * Almost every modem on the market uses this interface class.
 */
const modemProbeDetector: StateDetector = {
  stateId: 'modem',
  layer: LAYER,
  confidence: 'observed',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || probe.mode !== undefined) return false
    return hasInterfaceClass(probe.interfaces, USB_CLASS_CDC, USB_SUBCLASS_ACM)
  },
}

/**
 * Fallback storage detector: device has Mass Storage interface.
 *
 * Fires when `mode` is undefined but the device exposes a USB Mass Storage
 * interface. Common for modems that boot into CD-ROM mode initially.
 */
const storageProbeDetector: StateDetector = {
  stateId: 'storage',
  layer: LAYER,
  confidence: 'observed',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || probe.mode !== undefined) return false
    return hasInterfaceClass(probe.interfaces, USB_CLASS_MASS_STORAGE)
  },
}

// -- Exports ------------------------------------------------------------------

/** All generic state detectors (classified + observed fallbacks). */
export const GENERIC_DETECTORS: readonly StateDetector[] = [
  // Classified (mode-based) — tried first via layer priority
  absentDetector,
  storageDetector,
  modemDetector,
  downloadDetector,
  emergencyDetector,
  // Observed (interface-class-based) — fallback when mode is undefined
  modemProbeDetector,
  storageProbeDetector,
]
