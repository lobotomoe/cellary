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
import { UZ801_THERMAL } from './constants.js'

/** Target cap: the frequency the model declares as thermally stable. */
const TARGET_KHZ = UZ801_THERMAL.stableFrequencyKhz

export const uz801ThermalCap: Remediation = {
  id: 'thermal-cap',
  scope: 'thermal',
  description: `Cap CPU to ${TARGET_KHZ / 1000} MHz so the device does not thermally reboot`,
  recoverability: 'software-reversible',

  async isNeeded(ctx: RemediationContext): Promise<boolean> {
    const { maxKhz } = await ctx.modem.thermal.readCpuFrequency()
    // Needed whenever the CPU runs above the stable cap (e.g. fresh boot, where
    // mpdecision has restored the stock 1190 MHz maximum).
    return maxKhz > TARGET_KHZ
  },

  async apply(ctx: RemediationContext): Promise<void> {
    // setMaxFrequencyKhz stops the governor daemon and verifies the write.
    await ctx.modem.thermal.setMaxFrequencyKhz(TARGET_KHZ)
  },

  async verify(ctx: RemediationContext): Promise<boolean> {
    const { maxKhz } = await ctx.modem.thermal.readCpuFrequency()
    return maxKhz <= TARGET_KHZ
  },
}
