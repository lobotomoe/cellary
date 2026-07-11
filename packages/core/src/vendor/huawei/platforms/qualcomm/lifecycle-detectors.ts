/**
 * Qualcomm platform-level state detectors.
 *
 * The only Qualcomm-platform state that needs detection today is the E173's
 * serial modem mode at PID 0x1C05.
 *
 * PID 0x1C05 is shared with the Balong platform (where it means HDLC download
 * mode). There is no reliable single-probe discriminator, so we resolve the
 * ambiguity in favour of a working modem: a 0x1C05 device with a small number
 * of serial interfaces is treated as an E173-family stick, not download mode.
 * Balong download mode is entered by an explicit flash action and is detected
 * via probe.mode === 'download', not by interface counting -- see
 * ../balong/lifecycle-detectors.ts.
 */

import type { DeviceProbe, StateDetector } from '../../../../lifecycle/types.js'

const HUAWEI_VENDOR_ID = 0x12d1
const LAYER = 'qualcomm'

/** E173 serial modem mode. Shared PID with Balong download mode. */
const PID_QUALCOMM_MODEM = 0x1c05

/**
 * Balong sticks present 0x1C05 with 4+ interfaces (handled by the Balong stick
 * detector). E173 exposes fewer -- 3 serial ports (PCUI, Diag, Modem).
 */
const MAX_QUALCOMM_MODEM_INTERFACES = 4

function isHuawei(probe: DeviceProbe): boolean {
  return probe.vendorId === HUAWEI_VENDOR_ID
}

/**
 * Detect Qualcomm E173 stick mode via PID 0x1C05 interface count.
 *
 * 0x1C05 with fewer than 4 interfaces = E173-family serial modem (stick).
 * The usable state itself (`stick`) is defined at the Huawei vendor layer;
 * this detector only maps the Qualcomm-specific PID/interface signature to it.
 */
const qualcommStickDetector: StateDetector = {
  stateId: 'stick',
  layer: LAYER,
  confidence: 'identified',
  async detect(probe: DeviceProbe): Promise<boolean> {
    if (!probe.present || !isHuawei(probe)) return false
    if (probe.productId !== PID_QUALCOMM_MODEM) return false
    if (probe.interfaces === undefined) return false
    if (probe.interfaces.length === 0) return false
    return probe.interfaces.length < MAX_QUALCOMM_MODEM_INTERFACES
  },
}

/** All Qualcomm platform detectors. */
export const QUALCOMM_DETECTORS: readonly StateDetector[] = [qualcommStickDetector]
