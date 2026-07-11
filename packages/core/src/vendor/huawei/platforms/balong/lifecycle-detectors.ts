/**
 * Balong platform-level state detectors.
 *
 * Detects states specific to the Balong chipset platform:
 *   - stick           (0x1C05 modem mode, 4+ interfaces incl. CDC class)
 *   - balong_download (HDLC flash mode, via classifier mode === 'download')
 *
 * PID 0x1C05 is shared with the Qualcomm platform (E173's 3-port modem mode).
 * The ambiguity is resolved in favour of a working modem -- see the download
 * detector below and ../qualcomm/lifecycle-detectors.ts.
 */

import type { DeviceProbe, StateDetector } from '../../../../lifecycle/types.js'

const HUAWEI_VENDOR_ID = 0x12d1
const LAYER = 'balong'

/** Dual-purpose PID: modem or download mode depending on interfaces. */
const PID_BALONG_MISC = 0x1c05

const USB_CLASS_COMM = 0x02
const MIN_MODEM_INTERFACES = 4

function isHuawei(probe: DeviceProbe): boolean {
  return probe.vendorId === HUAWEI_VENDOR_ID
}

/**
 * Detect stick mode via PID 0x1C05 interface heuristic.
 *
 * PID 0x1C05 with 4+ interfaces including CDC class = modem/stick mode.
 * This is a Balong platform behavior — any Balong device can present
 * this PID after certain firmware configurations.
 */
const balongStickDetector: StateDetector = {
  stateId: 'stick',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || !isHuawei(probe)) return false
    if (probe.productId !== PID_BALONG_MISC) return false
    if (probe.interfaces === undefined) return false
    if (probe.interfaces.length < MIN_MODEM_INTERFACES) return false
    return probe.interfaces.some((iface) => iface.bInterfaceClass === USB_CLASS_COMM)
  },
}

/**
 * Detect Balong HDLC download mode.
 *
 * Relies solely on the classifier's `mode === 'download'` signal. The old
 * interface-count heuristic (0x1C05 with fewer than 4 interfaces = download)
 * is gone: it collided with the Qualcomm E173, whose normal 3-port modem mode
 * shares PID 0x1C05. There is no reliable single-probe discriminator between
 * E173 modem mode and Balong download mode, so 0x1C05 now defaults to a working
 * modem (see ../qualcomm/lifecycle-detectors.ts).
 *
 * Balong download mode is entered by an explicit `AT^GODLOAD` flash action, so
 * the flasher tracks that state itself and does not depend on cold-probe
 * detection here.
 */
const balongDownloadDetector: StateDetector = {
  stateId: 'balong_download',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    return probe.present && isHuawei(probe) && probe.mode === 'download'
  },
}

/** All Balong platform detectors. */
export const BALONG_DETECTORS: readonly StateDetector[] = [
  balongStickDetector,
  balongDownloadDetector,
]
