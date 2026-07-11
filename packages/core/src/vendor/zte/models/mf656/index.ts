import type { ModelInfo } from '../../../../types.js'
import { MF656_PID_MODEM, MF656_PID_STORAGE } from '../../usb-ids.js'

export { MF656_PID_MODEM, MF656_PID_STORAGE }

/**
 * ZTE MF656 — 3G WCDMA USB stick.
 *
 * Hardware-tested interface layout (PID 0x0031, modem mode):
 * - IF0: vendor (0xFF), 2 bulk EP — Diagnostics/DIAG (no AT response)
 * - IF1: vendor (0xFF), 2 bulk EP — AT command port (primary)
 * - IF2: mass storage (0x08)     — MicroSD card reader
 * - IF3: vendor (0xFF), 3 EP     — AT command port (secondary, has interrupt EP)
 *
 * Mode switch: PID 0x2000 (CD-ROM) -> eject -> PID 0x0031 (modem).
 * ICCID command: AT+ICCID (returns "ICCID: <value>").
 * Echo enabled by default — init must send ATE0.
 */
export const mf656Model: ModelInfo = {
  name: 'ZTE MF656',
}
