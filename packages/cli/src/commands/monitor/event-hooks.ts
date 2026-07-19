import type { CallEvent, RegistrationInfo, SimStateEvent, SmsNotification } from 'cellary'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'

import type { LogEntry } from './monitor-types.js'
import { createTimestamp, MAX_LOG_ENTRIES } from './monitor-types.js'

// ── Formatting helpers ──────────────────────────────────────────────────────

function registrationEventMessage(info: RegistrationInfo): string {
  const tech = info.technology !== undefined ? `, ${info.technology}` : ''
  switch (info.status) {
    case 'home':
      return `Connected (home${tech})`
    case 'roaming':
      return `Connected (roaming${tech})`
    case 'searching':
      return 'Searching for network...'
    case 'denied':
      return 'Registration denied'
    case 'notRegistered':
      return 'Disconnected'
    default:
      return 'Network state unknown'
  }
}

const SIM_STATE_LABELS: Record<SimStateEvent['state'], string> = {
  ready: 'SIM ready',
  pinRequired: 'SIM PIN required',
  pukRequired: 'SIM blocked -- PUK required',
  pin2Required: 'SIM PIN2 required',
  puk2Required: 'SIM PUK2 required',
  networkLocked: 'Network lock PIN required',
  unknown: 'SIM state unknown',
}

// ── useModemEvents ────────────────────────────────────────────────────────────

export function useModemEvents(handle: DeviceHandle): {
  entries: readonly LogEntry[]
  addEntry: (entry: LogEntry) => void
} {
  const [entries, setEntries] = useState<readonly LogEntry[]>([])

  const addEntry = useCallback((entry: LogEntry) => {
    setEntries((prev) => {
      const next = [...prev, entry]
      if (next.length > MAX_LOG_ENTRIES) {
        return next.slice(next.length - MAX_LOG_ENTRIES)
      }
      return next
    })
  }, [])

  // Store addEntry in ref to avoid re-subscribing on every render
  const addEntryRef = useRef(addEntry)
  addEntryRef.current = addEntry

  // Track last known technology from registration events that include it.
  // E3372 +CREG URCs omit AcT -- this fills in the gap from polled data.
  const lastTechRef = useRef<string | undefined>(undefined)

  // Deduplicate registration log entries -- suppress repeated identical messages
  const lastRegMessageRef = useRef<string | undefined>(undefined)

  // Seed technology cache from polled registration data at startup.
  // E3372 never includes AcT in +CREG URCs, but registration() falls back
  // to +COPS? which does include it. Without this seed, URC-driven NET
  // events would never show technology.
  useEffect(() => {
    let active = true
    handle.network
      .registration()
      .then((info) => {
        if (active && info.technology !== undefined) {
          lastTechRef.current = info.technology
        }
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [handle])

  useEffect(() => {
    const onCallState = (info: CallEvent): void => {
      const ts = createTimestamp()
      switch (info.state) {
        case 'incoming': {
          const from = info.number !== undefined ? ` from ${info.number}` : ''
          addEntryRef.current({ timestamp: ts, type: 'call', message: `Incoming call${from}` })
          break
        }
        case 'ended': {
          const REASON_LABELS: Record<string, string> = {
            busy: 'Remote party busy',
            noAnswer: 'No answer',
            noDialtone: 'No dial tone',
          }
          const reasonLabel =
            (info.reason !== undefined && REASON_LABELS[info.reason]) || 'Call ended'
          addEntryRef.current({ timestamp: ts, type: 'call', message: reasonLabel })
          break
        }
        // Other states (dialing, setup, alerting, active, held, waiting) --
        // not logged as events, they're tracked by the call state hook
        default:
          break
      }
    }

    const onSms = (notification: SmsNotification): void => {
      const PREVIEW_LEN = 30
      const storageLabel = notification.storage === 'unknown' ? 'storage' : notification.storage
      const ts = createTimestamp()

      // Read immediately -- show enriched entry if possible, fallback to generic
      handle.sms
        .read(notification.index)
        .then((msg) => {
          const preview =
            msg.text.length > PREVIEW_LEN ? `${msg.text.substring(0, PREVIEW_LEN)}...` : msg.text
          addEntryRef.current({
            timestamp: ts,
            type: 'sms',
            message: `${msg.address} (${storageLabel}): ${preview}`,
          })
        })
        .catch(() => {
          addEntryRef.current({
            timestamp: ts,
            type: 'sms',
            message: `New message (${storageLabel})`,
          })
        })
    }

    const onRegistration = (info: RegistrationInfo): void => {
      if (info.technology !== undefined) {
        lastTechRef.current = info.technology
      }
      const enriched =
        info.technology !== undefined ? info : { ...info, technology: lastTechRef.current }
      const message = registrationEventMessage(enriched)

      // Suppress duplicate entries -- +CREG URCs fire repeatedly with the
      // same status (e.g. after CSFB settles back on LTE).
      if (message === lastRegMessageRef.current) return
      lastRegMessageRef.current = message

      addEntryRef.current({
        timestamp: createTimestamp(),
        type: 'network',
        message,
      })
    }

    const onSimState = (info: SimStateEvent): void => {
      addEntryRef.current({
        timestamp: createTimestamp(),
        type: 'sim',
        message: SIM_STATE_LABELS[info.state],
      })
    }

    const onDisconnect = (): void => {
      addEntryRef.current({
        timestamp: createTimestamp(),
        type: 'error',
        message: 'Device disconnected',
        color: 'red',
      })
    }

    const onReconnect = (): void => {
      addEntryRef.current({
        timestamp: createTimestamp(),
        type: 'network',
        message: 'Device reconnected',
        color: 'green',
      })
    }

    const onReconnectFailed = (): void => {
      addEntryRef.current({
        timestamp: createTimestamp(),
        type: 'error',
        message: 'Reconnection failed -- plug in the device',
        color: 'red',
      })
    }

    handle.on('call:state', onCallState)
    handle.on('sms:received', onSms)
    handle.on('network:registration', onRegistration)
    handle.on('sim:state', onSimState)
    handle.on('disconnect', onDisconnect)
    handle.on('reconnect', onReconnect)
    handle.on('reconnect:failed', onReconnectFailed)

    return () => {
      handle.off('call:state', onCallState)
      handle.off('sms:received', onSms)
      handle.off('network:registration', onRegistration)
      handle.off('sim:state', onSimState)
      handle.off('disconnect', onDisconnect)
      handle.off('reconnect', onReconnect)
      handle.off('reconnect:failed', onReconnectFailed)
    }
  }, [handle])

  return { entries, addEntry }
}
