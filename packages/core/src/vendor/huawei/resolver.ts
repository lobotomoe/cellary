/**
 * Device state resolver for Huawei modems.
 *
 * Detects temporal patterns from USB bus observation:
 * - Mode-switching (storage PID -> modem PID transition)
 * - Stuck in storage mode (needs mode switch or replug)
 * - Stable modem operation
 */

import type {
  DeviceSessionSnapshot,
  DeviceStateAnalysis,
  DeviceStateResolver,
} from '../../discovery/observer-types.js'
import { huaweiUsbEntry } from './usb-entries.js'

// -- Constants ---------------------------------------------------------------

const HUAWEI_VID = 0x12d1

/** All known Huawei storage-mode PIDs */
const STORAGE_PIDS = new Set(huaweiUsbEntry.storageProducts)

/** If storage PID -> modem PID transition happens within this window, it's a mode switch */
const MODE_SWITCH_WINDOW_MS = 20_000

/** If stuck in storage longer than this, it's degraded */
const STUCK_STORAGE_THRESHOLD_MS = 30_000

/** On-bus duration before considering the device stable */
const STABLE_MIN_ON_BUS_MS = 30_000

// -- Resolver ----------------------------------------------------------------

export const huaweiResolver: DeviceStateResolver = {
  vendorId: HUAWEI_VID,

  analyze(session: DeviceSessionSnapshot): DeviceStateAnalysis | undefined {
    const { currentCycle, history, state, completedCycleCount } = session

    // Mode-switching: storage PID just left, modem PID appeared within window
    if (
      state === 'on-bus' &&
      currentCycle !== undefined &&
      !isStoragePid(currentCycle.pid) &&
      history.length > 0
    ) {
      const [prev] = history
      if (
        prev !== undefined &&
        isStoragePid(prev.pid) &&
        prev.detachedAt !== undefined &&
        currentCycle.attachedAt - prev.detachedAt < MODE_SWITCH_WINDOW_MS
      ) {
        return {
          state: 'mode-switching',
          severity: 'normal',
          description:
            `Mode switch: storage (0x${prev.pid.toString(16)}) -> ` +
            `modem (0x${currentCycle.pid.toString(16)})`,
          recommendations: ['Transition in progress, device should be ready shortly'],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      }
    }

    // Stuck in storage mode
    if (state === 'on-bus' && currentCycle !== undefined && isStoragePid(currentCycle.pid)) {
      const onBusMs = Date.now() - currentCycle.attachedAt
      if (onBusMs >= STUCK_STORAGE_THRESHOLD_MS) {
        return {
          state: 'stuck-storage',
          severity: 'degraded',
          description: `Device stuck in storage mode (PID 0x${currentCycle.pid.toString(16)}) for ${fmtMs(onBusMs)}`,
          recommendations: [
            'Try automatic mode switch: cellary prepare',
            'Or physically disconnect and reconnect the device',
          ],
          expectedNextPid: undefined,
          estimatedRecoveryMs: undefined,
        }
      }

      // Just appeared in storage mode -- waiting for mode switch
      return {
        state: 'storage-mode',
        severity: 'normal',
        description: `Device in storage mode (PID 0x${currentCycle.pid.toString(16)}), awaiting mode switch`,
        recommendations: [],
        expectedNextPid: undefined,
        estimatedRecoveryMs: undefined,
      }
    }

    // Stable modem mode
    if (state === 'on-bus' && currentCycle !== undefined && !isStoragePid(currentCycle.pid)) {
      const onBusMs = Date.now() - currentCycle.attachedAt
      if (onBusMs >= STABLE_MIN_ON_BUS_MS) {
        return {
          state: 'stable',
          severity: 'normal',
          description: `Device stable in modem mode for ${fmtMs(onBusMs)}`,
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

    return undefined
  },
}

// -- Helpers -----------------------------------------------------------------

function isStoragePid(pid: number): boolean {
  return STORAGE_PIDS.has(pid)
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}
