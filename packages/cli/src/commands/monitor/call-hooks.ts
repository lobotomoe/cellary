import type { CallEvent } from 'cellary'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'

import type { LogEntry } from './monitor-types.js'
import { createTimestamp } from './monitor-types.js'

// ── Call State ────────────────────────────────────────────────────────────

/**
 * Outgoing call progress stages for timeout management.
 * Values align with core CallState where applicable:
 *
 * - dialing:  dial() called, waiting for the modem to confirm call setup began
 * - setup:    call setup message received (vendor-dependent, e.g. ^ORIG on Huawei)
 * - alerting: network confirmed, remote phone is ringing (e.g. ^CONF on Huawei)
 * - active:   remote party answered (e.g. ^CONN on Huawei)
 *
 * If no setup message arrives, the call stays at 'dialing' --
 * meaning it never left the modem (e.g. CSFB failure on data sticks).
 */
export type CallStage = 'dialing' | 'setup' | 'alerting' | 'active'

/** Auto-hangup timeouts per stage (seconds) */
const STAGE_TIMEOUT_S: Record<CallStage, number | undefined> = {
  dialing: 30, // Call never left the modem -- give up quickly
  setup: 60, // Modem trying but network not responding
  alerting: 120, // Network confirmed, but no answer from remote
  active: undefined, // Active call -- no timeout
}

export type CallState =
  | { readonly active: false }
  | {
      readonly active: true
      readonly direction: 'outgoing' | 'incoming'
      readonly stage: CallStage
      readonly number?: string
      readonly startedAt: number
    }

const IDLE_CALL: CallState = { active: false }

/**
 * RING URCs arrive every ~5s during incoming calls. If no RING arrives
 * within this window, the caller hung up. Set slightly above the ring
 * interval to tolerate jitter.
 */
const RING_WATCHDOG_MS = 8000

/**
 * CLCC poll interval for active calls. Catches call termination on devices
 * that don't emit NO CARRIER or ^CEND (e.g. Huawei E3372).
 */
const CLCC_POLL_MS = 3000

export function useCallState(
  handle: DeviceHandle,
  onLog?: ((entry: LogEntry) => void) | undefined,
): {
  callState: CallState
  startCall: (number: string) => void
  resetCall: () => void
} {
  const [state, setState] = useState<CallState>(IDLE_CALL)
  const ringWatchdogRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onLogRef = useRef(onLog)
  onLogRef.current = onLog

  const clearRingWatchdog = useCallback(() => {
    if (ringWatchdogRef.current !== undefined) {
      clearTimeout(ringWatchdogRef.current)
      ringWatchdogRef.current = undefined
    }
  }, [])

  const startCall = useCallback(
    (number: string) => {
      clearRingWatchdog()
      setState({
        active: true,
        direction: 'outgoing',
        stage: 'dialing',
        number,
        startedAt: Date.now(),
      })
    },
    [clearRingWatchdog],
  )

  const resetCall = useCallback(() => {
    clearRingWatchdog()
    setState(IDLE_CALL)
  }, [clearRingWatchdog])

  useEffect(() => {
    const resetRingWatchdog = (): void => {
      clearRingWatchdog()
      ringWatchdogRef.current = setTimeout(() => {
        // No RING for RING_WATCHDOG_MS -- caller hung up
        setState((prev) => {
          if (prev.active && prev.direction === 'incoming') {
            onLogRef.current?.({
              timestamp: createTimestamp(),
              type: 'call',
              message: 'Caller hung up',
            })
            return IDLE_CALL
          }
          return prev
        })
      }, RING_WATCHDOG_MS)
    }

    const onCallState = (info: CallEvent): void => {
      switch (info.state) {
        case 'incoming': {
          setState((prev) => {
            // Don't override outgoing with incoming
            if (prev.active && prev.direction === 'outgoing') return prev

            // Reset watchdog on each incoming event (replaces RING handler)
            resetRingWatchdog()

            if (prev.active && prev.direction === 'incoming') {
              // Already tracking -- update number if newly available
              if (info.number !== undefined && prev.number === undefined) {
                return { ...prev, number: info.number }
              }
              return prev
            }

            const base = {
              active: true as const,
              direction: 'incoming' as const,
              stage: 'alerting' as const,
              startedAt: Date.now(),
            }
            return info.number !== undefined ? { ...base, number: info.number } : base
          })
          break
        }

        case 'ended': {
          clearRingWatchdog()
          setState(IDLE_CALL)
          break
        }

        // Outgoing call progress stages
        case 'setup': {
          setState((prev) => {
            if (!prev.active || prev.direction !== 'outgoing') return prev
            if (prev.stage === 'dialing') return { ...prev, stage: 'setup' }
            return prev
          })
          break
        }

        case 'alerting': {
          setState((prev) => {
            if (!prev.active || prev.direction !== 'outgoing') return prev
            if (prev.stage === 'dialing' || prev.stage === 'setup') {
              return { ...prev, stage: 'alerting' }
            }
            return prev
          })
          break
        }

        case 'active': {
          setState((prev) => {
            if (!prev.active) return prev
            return { ...prev, stage: 'active' }
          })
          break
        }

        default:
          break
      }
    }

    handle.on('call:state', onCallState)

    return () => {
      handle.off('call:state', onCallState)
      clearRingWatchdog()
    }
  }, [handle, clearRingWatchdog])

  return { callState: state, startCall, resetCall }
}

/** Hook that ticks every second while a call is active, returning elapsed seconds */
export function useCallTimer(callState: CallState): number {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!callState.active) {
      setElapsed(0)
      return
    }

    const tick = (): void => {
      setElapsed(Math.floor((Date.now() - callState.startedAt) / 1000))
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [callState])

  return elapsed
}

/**
 * CLCC-based call end detection.
 *
 * Some modems (E3372) don't emit NO CARRIER or ^CEND when a call ends.
 * This hook polls AT+CLCC while a call is active. When CLCC returns no
 * active calls, it resets the call state.
 *
 * This is the proper fallback for devices without call termination URCs.
 * The ring watchdog handles the specific case of incoming ringing calls
 * (faster detection via missing RING), while this catches everything else:
 * outgoing calls that drop, answered calls that end, etc.
 */
export function useCallPoller(
  handle: DeviceHandle,
  callState: CallState,
  onLog: (entry: LogEntry) => void,
  resetCall: () => void,
): void {
  const onLogRef = useRef(onLog)
  onLogRef.current = onLog

  const resetCallRef = useRef(resetCall)
  resetCallRef.current = resetCall

  useEffect(() => {
    if (!callState.active) return

    const id = setInterval(() => {
      handle.voice
        .listCalls()
        .then((calls) => {
          if (calls.length === 0) {
            onLogRef.current({
              timestamp: createTimestamp(),
              type: 'call',
              message: 'Call ended',
            })
            resetCallRef.current()
          }
        })
        .catch(() => {
          // CLCC failed -- don't reset, might be transient
        })
    }, CLCC_POLL_MS)

    return () => clearInterval(id)
  }, [handle, callState.active])
}

/**
 * Auto-hangup outgoing calls based on call stage timeouts.
 *
 * Different stages have different timeouts:
 * - dialing (30s): call never left the modem, likely CSFB failure
 * - setup (60s): modem trying but network not responding
 * - alerting (120s): network confirmed but remote not answering
 * - active: no timeout (active call)
 *
 * The timer resets when the stage advances (e.g. dialing -> setup).
 */
export function useAutoHangup(
  handle: DeviceHandle,
  callState: CallState,
  onLog: (entry: LogEntry) => void,
  resetCall: () => void,
): void {
  const onLogRef = useRef(onLog)
  onLogRef.current = onLog

  const resetCallRef = useRef(resetCall)
  resetCallRef.current = resetCall

  useEffect(() => {
    if (!callState.active || callState.direction !== 'outgoing') return

    const timeoutS = STAGE_TIMEOUT_S[callState.stage]
    if (timeoutS === undefined) return // active -- no timeout

    const id = setTimeout(() => {
      handle.voice
        .hangup()
        .then(() => {
          onLogRef.current({
            timestamp: createTimestamp(),
            type: 'call',
            message: `Auto-hangup: stuck at '${callState.stage}' for ${timeoutS}s`,
          })
        })
        .catch(() => {})
        .finally(() => {
          // Force-reset call state -- the modem may not send NO CARRIER / ^CEND
          resetCallRef.current()
        })
    }, timeoutS * 1000)

    return () => clearTimeout(id)
  }, [handle, callState])
}
