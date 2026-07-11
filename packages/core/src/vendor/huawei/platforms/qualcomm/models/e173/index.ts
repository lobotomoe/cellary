/**
 * Huawei E173 (Qualcomm MSM62xx, 3G HSPA stick).
 *
 * NOT a Balong device. The E173 predates HiSilicon Balong -- it runs on a
 * Qualcomm baseband, exposes a Qualcomm DIAG port, and has no Linux/adb shell,
 * no HDLC/BootROM flash path, and no HiLink HTTP API. Its driver package names
 * the install sections `QcomDevice`/`QportInstall` (see ew_hwusbdev.inf).
 *
 * Mode switch: standard usb_modeswitch. Storage/CD-ROM PID 0x1C0B re-enumerates
 * to modem PID 0x1C05 via the Huawei SCSI CBW or vendor control transfer.
 *
 * Minimal model on purpose: capabilities (voice, STK, SMS mode) are left to
 * runtime discovery (^CVOICE?, CLAC) rather than hardcoded. The E173 is voice
 * capable, but we only override discovery once a real divergence is observed
 * on hardware.
 */

import type { ModelInfo } from '../../../../../../types.js'

// ── USB Product IDs ───────────────────────────────────────────────────────────

/** E173 in storage / CD-ROM mode (initial state after plug-in). */
export const E173_PID_STORAGE = 0x1c0b

/** E173 in serial modem mode (3 ports: PCUI, Diag, Modem). SCSI/vendor switch produces this. */
export const E173_PID_MODEM = 0x1c05

export const huaweiE173: ModelInfo = {
  name: 'Huawei E173',
}
