/**
 * Device state resolver for MSM8916-based OEM 4G dongles.
 *
 * Detects temporal patterns from USB bus observation:
 * - Thermal boot-loop (MSM8916 devices without CPU cap)
 * - EDL mode (bricked, needs QFIL reflash)
 * - USB composition changes (PID transitions)
 * - Stable operation
 */

import type {
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
} from '../../discovery/observer-types.js'
import { UZ801_PID_EDL, UZ801_THERMAL } from './models/index.js'
import { QUALCOMM_VID } from './usb-ids.js'

// -- Thresholds --------------------------------------------------------------

/** If avg on-bus < this, it's a boot-loop. 15s covers the observed 8s UZ801 pattern. */
const BOOT_LOOP_MAX_ON_BUS_MS = 15_000
/** Minimum completed cycles before declaring boot-loop. */
const BOOT_LOOP_MIN_CYCLES = 2
/** On-bus duration before considering the device stable. */
const STABLE_MIN_ON_BUS_MS = 30_000

// -- Resolver ----------------------------------------------------------------

export const msm8916OemResolver: DeviceStateResolver = {
  vendorId: QUALCOMM_VID,

  analyze(session: DeviceSessionSnapshot): DeviceStateAnalysis | undefined {
    const { currentCycle, history, state, completedCycleCount, avgOnBusDurationMs } = session

    // EDL mode -- device is bricked
    if (currentCycle !== undefined && currentCycle.pid === UZ801_PID_EDL) {
      return {
        state: 'edl-mode',
        severity: 'critical',
        description: 'Device is in Qualcomm Emergency Download (EDL) mode',
        recommendations: [
          'Device needs reflashing with Qualcomm QFIL or similar tool',
          'Not recoverable via normal USB operations',
        ],
        expectedNextPid: undefined,
        estimatedRecoveryMs: undefined,
      }
    }

    // Thermal boot-loop -- rapid cycling with short on-bus time
    if (
      completedCycleCount >= BOOT_LOOP_MIN_CYCLES &&
      avgOnBusDurationMs !== undefined &&
      avgOnBusDurationMs < BOOT_LOOP_MAX_ON_BUS_MS
    ) {
      const avgOff = session.avgOffBusDurationMs
      return {
        state: 'thermal-boot-loop',
        severity: 'critical',
        description:
          `Device is thermal-cycling: ~${fmtMs(avgOnBusDurationMs)} on bus, ` +
          `~${avgOff !== undefined ? fmtMs(avgOff) : '?'} off bus. ` +
          `${completedCycleCount} cycles observed.`,
        recommendations: [
          `Cap CPU to ${UZ801_THERMAL.stableFrequencyKhz / 1000} MHz via ADB:`,
          `  adb shell 'stop mpdecision; echo ${UZ801_THERMAL.stableFrequencyKhz} > ${UZ801_THERMAL.cpuFreqMaxPath}'`,
          'Must be applied within the on-bus window (before next thermal shutdown)',
          'Fix is volatile -- must be reapplied after every reboot',
        ],
        expectedNextPid: currentCycle?.pid ?? history[0]?.pid,
        estimatedRecoveryMs: avgOff,
      }
    }

    // Composition change -- PID changed from previous cycle
    const [prevCycle] = history
    if (
      state === 'on-bus' &&
      currentCycle !== undefined &&
      prevCycle !== undefined &&
      prevCycle.pid !== currentCycle.pid
    ) {
      return {
        state: 'composition-change',
        severity: 'normal',
        description:
          `USB composition changed: PID 0x${prevCycle.pid.toString(16)} -> ` +
          `0x${currentCycle.pid.toString(16)}`,
        recommendations: [
          'PID is determined by persist.sys.usb.config (NVM)',
          'Only "rndis" and "rndis,serial_smd,diag,adb" survive reboots',
        ],
        expectedNextPid: undefined,
        estimatedRecoveryMs: undefined,
      }
    }

    // Stable -- on bus long enough with no rapid cycling
    if (state === 'on-bus' && currentCycle !== undefined) {
      const onBusMs = Date.now() - currentCycle.attachedAt
      if (onBusMs >= STABLE_MIN_ON_BUS_MS) {
        return {
          state: 'stable',
          severity: 'normal',
          description: `Device stable for ${fmtMs(onBusMs)}`,
          recommendations: [],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      }
    }

    // Cold start -- first appearance, no history yet
    if (state === 'on-bus' && completedCycleCount === 0) {
      return {
        state: 'cold-start',
        severity: 'normal',
        description:
          currentCycle !== undefined
            ? `Device appeared at PID 0x${currentCycle.pid.toString(16)}`
            : 'Device appeared',
        recommendations: [],
        expectedNextPid: undefined,
        estimatedRecoveryMs: undefined,
      }
    }

    // Off bus with history -- waiting for re-enumeration
    if (state === 'off-bus' && completedCycleCount > 0) {
      return {
        state: 'waiting',
        severity: 'normal',
        description: `Device disconnected after ${completedCycleCount} cycle(s)`,
        recommendations: [],
        expectedNextPid: history[0]?.pid,
        estimatedRecoveryMs: session.avgOffBusDurationMs,
      }
    }

    return undefined
  },
}

// -- Helpers -----------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}
