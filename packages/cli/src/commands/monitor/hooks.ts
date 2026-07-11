import { useEffect, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'

export type { LogEntry } from './monitor-types.js'
export { createTimestamp, MAX_LOG_ENTRIES } from './monitor-types.js'

// ── useConnectionState ────────────────────────────────────────────────────────

export type ConnectionState = 'connected' | 'reconnecting' | 'failed'

/**
 * Track modem connection state via disconnect/reconnect events.
 * Returns 'connected' initially, 'reconnecting' after USB unplug,
 * and 'connected' again after successful reconnection.
 */
export function useConnectionState(handle: DeviceHandle): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connected')

  useEffect(() => {
    const onDisconnect = (): void => setState('reconnecting')
    const onReconnect = (): void => setState('connected')
    const onFailed = (): void => setState('failed')

    handle.on('disconnect', onDisconnect)
    handle.on('reconnect', onReconnect)
    handle.on('reconnect:failed', onFailed)

    return () => {
      handle.off('disconnect', onDisconnect)
      handle.off('reconnect', onReconnect)
      handle.off('reconnect:failed', onFailed)
    }
  }, [handle])

  return state
}

// ── Re-exports ───────────────────────────────────────────────────────────────

export type { CallStage, CallState } from './call-hooks.js'
export { useAutoHangup, useCallPoller, useCallState, useCallTimer } from './call-hooks.js'
export { useModemEvents } from './event-hooks.js'
export {
  useOperator,
  usePhoneNumber,
  useRegistration,
  useSignal,
  useSignalHistory,
  useTemperature,
} from './polling-hooks.js'
