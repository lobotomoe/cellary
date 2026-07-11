/**
 * UZ801 thermal-cap remediation — the first instance of the preparation
 * remediation framework.
 *
 * The MSM8916 stick thermally reboots at stock CPU speed (1190 MHz) because it
 * has no thermal interface material between the SoC and RF shield. Capping the
 * max CPU frequency keeps it alive. The cap is software-only and volatile (lost
 * on reboot), so it is `software-reversible` and safe to auto-apply.
 *
 * All the sysfs/mpdecision mechanics live in the Thermal service
 * (Msm8916Thermal); this remediation is pure policy: detect an uncapped CPU,
 * apply the stable cap, verify it held.
 */

import type { Remediation, RemediationContext } from '../../../../preparation/types.js'
import type { Thermal } from '../../../../protocols/services/thermal.js'
import { UZ801_THERMAL } from './constants.js'

/** Target cap: the frequency the model declares as thermally stable. */
const TARGET_KHZ = UZ801_THERMAL.stableFrequencyKhz

interface ThermalCapable {
  readonly thermal: Thermal
}

/**
 * Narrow the remediation context's `unknown` modem to something with a thermal
 * service. `modem.thermal` is always present on a real Modem (routed service
 * with a NotSupported fallback), so the presence check is sound — and it avoids
 * both an `as` cast and a circular import of the Modem type.
 */
function isThermalCapable(modem: unknown): modem is ThermalCapable {
  return typeof modem === 'object' && modem !== null && 'thermal' in modem
}

function thermalOf(ctx: RemediationContext): Thermal {
  if (!isThermalCapable(ctx.modem)) {
    throw new Error('Thermal remediation requires a modem with a thermal service')
  }
  return ctx.modem.thermal
}

export const uz801ThermalCap: Remediation = {
  id: 'thermal-cap',
  scope: 'thermal',
  description: `Cap CPU to ${TARGET_KHZ / 1000} MHz so the device does not thermally reboot`,
  recoverability: 'software-reversible',

  async isNeeded(ctx: RemediationContext): Promise<boolean> {
    const { maxKhz } = await thermalOf(ctx).readCpuFrequency()
    // Needed whenever the CPU runs above the stable cap (e.g. fresh boot, where
    // mpdecision has restored the stock 1190 MHz maximum).
    return maxKhz > TARGET_KHZ
  },

  async apply(ctx: RemediationContext): Promise<void> {
    // setMaxFrequencyKhz stops the governor daemon and verifies the write.
    await thermalOf(ctx).setMaxFrequencyKhz(TARGET_KHZ)
  },

  async verify(ctx: RemediationContext): Promise<boolean> {
    const { maxKhz } = await thermalOf(ctx).readCpuFrequency()
    return maxKhz <= TARGET_KHZ
  },
}
