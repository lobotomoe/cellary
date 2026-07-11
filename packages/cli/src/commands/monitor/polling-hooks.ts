import { type RegistrationInfo, resolveOperatorName, type SignalInfo } from 'cellary'
import { useEffect, useRef, useState } from 'react'
import type { DeviceHandle } from '../../backend/types.js'

// ── useSignal ─────────────────────────────────────────────────────────────────

export function useSignal(handle: DeviceHandle, intervalMs = 10_000): SignalInfo | undefined {
  const [signal, setSignal] = useState<SignalInfo | undefined>()

  useEffect(() => {
    let active = true

    const poll = (): void => {
      handle.network
        .signal()
        .then((info) => {
          if (active) setSignal(info)
        })
        .catch(() => {
          // Modem may be busy with another command -- retry next interval
        })
    }

    // Poll immediately, then on interval
    poll()
    const id = setInterval(poll, intervalMs)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [handle, intervalMs])

  return signal
}

// ── useSignalHistory ─────────────────────────────────────────────────────────

const HISTORY_MAX_SAMPLES = 30

/**
 * Collect RSSI values over time into a rolling buffer for sparkline rendering.
 * Piggybacks on useSignal — each new signal value appends to the history.
 */
export function useSignalHistory(signal: SignalInfo | undefined): readonly number[] {
  const historyRef = useRef<number[]>([])
  const [history, setHistory] = useState<readonly number[]>([])

  useEffect(() => {
    if (signal === undefined || signal.rssi === undefined) return

    const buf = historyRef.current
    buf.push(signal.rssi)
    if (buf.length > HISTORY_MAX_SAMPLES) {
      buf.shift()
    }
    setHistory([...buf])
  }, [signal])

  return history
}

// ── useTemperature ───────────────────────────────────────────────────────────

export function useTemperature(handle: DeviceHandle, intervalMs = 30_000): number | undefined {
  const [temp, setTemp] = useState<number | undefined>()

  useEffect(() => {
    let active = true
    const tempFn = handle.device.temperature

    if (tempFn === undefined) return

    const poll = (): void => {
      tempFn
        .call(handle.device)
        .then((value) => {
          if (active) setTemp(value)
        })
        .catch(() => {})
    }

    poll()
    const id = setInterval(poll, intervalMs)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [handle, intervalMs])

  return temp
}

// ── useRegistration ───────────────────────────────────────────────────────────

export function useRegistration(
  handle: DeviceHandle,
  intervalMs = 30_000,
): RegistrationInfo | undefined {
  const [reg, setReg] = useState<RegistrationInfo | undefined>()

  useEffect(() => {
    let active = true

    const poll = (): void => {
      handle.network
        .registration()
        .then((info) => {
          if (active) setReg(info)
        })
        .catch(() => {})
    }

    poll()
    const id = setInterval(poll, intervalMs)

    // Also update on network:registration events (emitted by any adapter).
    // URC-sourced events often lack technology (Huawei +CREG omits AcT) --
    // preserve the last known technology from polling when the event omits it.
    const handler = (info: RegistrationInfo): void => {
      if (!active) return
      if (info.technology !== undefined) {
        setReg(info)
      } else {
        setReg((prev) =>
          prev?.technology !== undefined ? { ...info, technology: prev.technology } : info,
        )
      }
    }
    handle.on('network:registration', handler)

    return () => {
      active = false
      clearInterval(id)
      handle.off('network:registration', handler)
    }
  }, [handle, intervalMs])

  return reg
}

// ── useOperator ───────────────────────────────────────────────────────────────

export function useOperator(handle: DeviceHandle): string | undefined {
  const [operator, setOperator] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    handle.network
      .operator()
      .then((name) => {
        if (active && name !== undefined) setOperator(resolveOperatorName(name))
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [handle])

  return operator
}

// ── usePhoneNumber ────────────────────────────────────────────────────────────

export function usePhoneNumber(handle: DeviceHandle): string | undefined {
  const [number, setNumber] = useState<string | undefined>()

  useEffect(() => {
    let active = true
    handle.sim
      .phoneNumber?.()
      ?.then((num) => {
        if (active && num !== undefined) setNumber(num)
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [handle])

  return number
}
