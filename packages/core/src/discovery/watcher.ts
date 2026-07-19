/**
 * USB modem hot-plug monitoring.
 *
 * watch() uses the usb package's attach/detach events to notify callers
 * when modems are connected or disconnected — no polling required.
 *
 * Serial port modems are not covered here (no OS-level serial hot-plug
 * events). For serial, poll with discover() on a timer if needed.
 */

import type { Device } from 'usb'
import { getDeviceList, usb } from 'usb'

import { classifyDevice, deviceIdForDevice } from './classify.js'
import type { DiscoveredModem } from './usb-types.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModemWatchEvent {
  /** 'attached' when a modem is connected, 'detached' when disconnected */
  readonly type: 'attached' | 'detached'
  readonly modem: DiscoveredModem
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Watch for modem connect/disconnect events.
 *
 * Uses USB hot-plug notifications — no polling required.
 * Does NOT emit events for modems already connected at call time
 * (use discover() for the initial state), but does track them
 * internally so 'detached' fires correctly when they disconnect.
 *
 * Returns a stop function. Call it to unsubscribe.
 *
 * @example
 * ```ts
 * const stop = watch((event) => {
 *   if (event.type === 'attached') openModem(event.modem)
 *   if (event.type === 'detached') cleanup(event.modem)
 * })
 *
 * // later:
 * stop()
 * ```
 */
export function watch(listener: (event: ModemWatchEvent) => void): () => void {
  // Track currently known USB modems so we can emit 'detached' on disconnect.
  // Key: deviceId (vendorId:busNumber-portPath) — stable across PID changes.
  const known = new Map<string, DiscoveredModem>()

  // Seed from currently connected USB devices (no events emitted)
  for (const device of getDeviceList()) {
    const modem = classifyDevice(device)
    if (modem !== undefined) {
      known.set(modem.deviceId, modem)
    }
  }

  const handleAttach = (device: Device) => {
    const modem = classifyDevice(device)
    if (modem === undefined) return

    const key = modem.deviceId
    if (known.has(key)) return // already tracked (duplicate event)

    known.set(key, modem)
    listener({ type: 'attached', modem })
  }

  const handleDetach = (device: Device) => {
    // Do NOT re-classify on detach: the device is gone, so its interface
    // descriptors are unreadable and an unknown (CDC-probed) device would fail
    // to classify — losing the detach event and leaking the entry in `known`.
    // The deviceId is a pure function of vendorId + bus location, all cached on
    // the Device, so recompute the exact key that attach stored.
    const key = deviceIdForDevice(device)
    const stored = known.get(key)
    if (stored === undefined) return

    known.delete(key)
    // Emit the stored modem — it holds the full classification captured at attach.
    listener({ type: 'detached', modem: stored })
  }

  usb.on('attach', handleAttach)
  usb.on('detach', handleDetach)

  return () => {
    usb.off('attach', handleAttach)
    usb.off('detach', handleDetach)
  }
}
