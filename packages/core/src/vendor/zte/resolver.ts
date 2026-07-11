/**
 * Device state resolver for ZTE USB modems.
 *
 * Detects temporal patterns from USB bus observation:
 * - Storage mode (PID 0x2000) — needs mode switch
 * - Modem mode — stable operation
 * - Mode switching in progress — CD-ROM ejected, waiting for re-enumeration
 */

import type {
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
} from '../../discovery/observer-types.js'
import { MF656_PID_STORAGE, ZTE_VID } from './usb-ids.js'

const STABLE_MIN_ON_BUS_MS = 15_000

export const zteResolver: DeviceStateResolver = {
  vendorId: ZTE_VID,

  analyze(session: DeviceSessionSnapshot): DeviceStateAnalysis | undefined {
    const { currentCycle, state, completedCycleCount } = session

    // Storage mode — needs CD-ROM eject to switch
    if (state === 'on-bus' && currentCycle?.pid === MF656_PID_STORAGE) {
      return {
        state: 'storage-mode',
        severity: 'normal',
        description: 'Device is in CD-ROM/storage mode, needs mode switch',
        recommendations: ['Eject the virtual CD-ROM to trigger modem mode'],
        expectedNextPid: undefined,
        estimatedRecoveryMs: 5_000,
      }
    }

    // Stable modem mode
    if (state === 'on-bus' && currentCycle !== undefined) {
      const onBusMs = Date.now() - currentCycle.attachedAt
      if (onBusMs >= STABLE_MIN_ON_BUS_MS) {
        return {
          state: 'stable',
          severity: 'normal',
          description: `Device stable for ${(onBusMs / 1_000).toFixed(1)}s`,
          recommendations: [],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      }
    }

    // Cold start
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

    // Off bus with history
    if (state === 'off-bus' && completedCycleCount > 0) {
      return {
        state: 'waiting',
        severity: 'normal',
        description: `Device disconnected after ${completedCycleCount} cycle(s)`,
        recommendations: [],
        expectedNextPid: undefined,
        estimatedRecoveryMs: session.avgOffBusDurationMs,
      }
    }

    return undefined
  },
}
