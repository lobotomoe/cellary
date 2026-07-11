/**
 * Device identification -- the formal level 2 between discovery and connection.
 *
 * Takes a DiscoveredModem (level 1, ~100ms USB scan) and enriches it
 * with model name, protocol list, and connection display info (~1-3s probes).
 *
 * All probing logic lives here. CLI/GUI/fleet call identify() and render.
 * No ad-hoc probes scattered in consumers.
 */

import { createConnection } from 'node:net'

import type { VendorPlugin } from '../protocols/adapter.js'
import type { ModelInfo } from '../types.js'
import { DEFAULT_VENDORS } from '../vendor-registry.js'
import { findModemEntry, findProductConfig } from './usb-ids.js'
import type { DiscoveredModem, UsbModemEntry } from './usb-types.js'

// ── Types ────────────────────────────────────────────────────────────────────

/** An identified device -- discovery data enriched with identification probes. */
export interface IdentifiedDevice {
  /** The discovered modem this identification was derived from. */
  readonly discovered: DiscoveredModem
  /** Display name for the device (model or vendor name). */
  readonly displayName: string
  /** Model info from static database or runtime probe. Undefined for unknown models. */
  readonly model: ModelInfo | undefined
  /** Protocol names in priority order. Only includes reachable protocols. */
  readonly protocols: readonly string[]
}

export interface IdentifyOptions {
  /** Vendor plugin map. Defaults to all built-in vendors. */
  readonly vendors?: ReadonlyMap<string, VendorPlugin> | undefined
  /** Whether to probe ADB reachability on HTTP-mode devices. Default: true. */
  readonly probeAdb?: boolean | undefined
}

// ── ADB probe ────────────────────────────────────────────────────────────────

const ADB_PORT = 5555
const ADB_PROBE_TIMEOUT_MS = 1_500

/** Lightweight TCP-only check for ADB port. No handshake, just connect. */
function probeAdbReachable(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: ADB_PORT, timeout: ADB_PROBE_TIMEOUT_MS })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

// ── Display name resolution ──────────────────────────────────────────────────

/**
 * Resolve display name from static USB database.
 *
 * For modem-mode: uses the exact model name from product config.
 * For storage-mode: lists all possible models from the vendor entry.
 * For special modes: appends the mode label.
 */
function staticDisplayName(d: DiscoveredModem): string {
  if (d.mode === 'emergency') return `${d.name} [BootROM]`
  if (d.mode === 'download') return `${d.name} [Download]`

  if (d.mode !== 'storage') {
    const entry = d.entry ?? findModemEntry(d.vendorId, d.productId)
    const config = findProductConfig(entry, d.productId)
    return config?.model?.name ?? d.name
  }

  // Storage mode: collect unique short model names from all modem products.
  const storageEntry = d.entry ?? findModemEntry(d.vendorId, d.productId)
  if (storageEntry === undefined) return d.name
  return storageDisplayName(d.name, storageEntry)
}

/** Build display name for storage-mode devices listing all possible models. */
function storageDisplayName(vendorName: string, entry: UsbModemEntry): string {
  const vendorPrefix = `${vendorName} `
  const shortModels = new Set<string>()
  for (const product of entry.modemProducts) {
    if (product.model !== undefined) {
      const full = product.model.name
      shortModels.add(full.startsWith(vendorPrefix) ? full.slice(vendorPrefix.length) : full)
    }
  }
  if (shortModels.size === 0) return vendorName
  return `${vendorName} ${[...shortModels].join('/')}`
}

// ── Protocol name resolution ─────────────────────────────────────────────────

/** Infer a protocol display name from the product config driver. */
function inferProtocolName(d: DiscoveredModem): string {
  if (d.mode !== 'http') return 'at'
  const entry = d.entry ?? findModemEntry(d.vendorId, d.productId)
  const config = findProductConfig(entry, d.productId)
  return config?.driver?.kind === 'vendor' ? config.driver.api : 'HTTP'
}

// ── Core identification ──────────────────────────────────────────────────────

/** Find the vendor plugin for a discovered modem. */
function findPlugin(
  d: DiscoveredModem,
  vendors: ReadonlyMap<string, VendorPlugin>,
): VendorPlugin | undefined {
  const entry = d.entry ?? findModemEntry(d.vendorId, d.productId)
  const vendorId = entry?.profile.vendorId
  if (vendorId === undefined) return undefined
  return vendors.get(vendorId)
}

/**
 * Identify a single discovered device.
 *
 * Runs lightweight probes (~1-3s) to determine:
 * - Actual model name (via vendor plugin HTTP probe if USB PID is shared)
 * - Available protocols in priority order (filtered by reachability)
 */
export async function identify(
  discovered: DiscoveredModem,
  options?: IdentifyOptions,
): Promise<IdentifiedDevice> {
  const vendors = options?.vendors ?? DEFAULT_VENDORS
  const shouldProbeAdb = options?.probeAdb !== false

  // Non-modem modes: no probing needed
  if (
    discovered.mode === 'storage' ||
    discovered.mode === 'download' ||
    discovered.mode === 'emergency'
  ) {
    return {
      discovered,
      displayName: staticDisplayName(discovered),
      model: undefined,
      protocols: [],
    }
  }

  // Serial/modem-usb: AT only, no probing
  if (discovered.mode === 'serial' || discovered.mode === 'modem-usb') {
    return {
      discovered,
      displayName: staticDisplayName(discovered),
      model: staticModel(discovered),
      protocols: ['at'],
    }
  }

  // HTTP mode: vendor plugin identification + ADB probe
  const plugin = findPlugin(discovered, vendors)
  const pluginId =
    plugin?.identify !== undefined
      ? await plugin.identify(discovered).catch(() => undefined)
      : undefined

  // Resolve display name: plugin probe > static database
  const resolvedName =
    pluginId?.displayName !== undefined
      ? `${discovered.name} ${pluginId.displayName}`
      : staticDisplayName(discovered)

  // Resolve protocols: plugin provides priority-ordered list, we filter by reachability
  let protocols: readonly string[]
  if (pluginId !== undefined) {
    protocols = pluginId.protocols
  } else {
    protocols = [inferProtocolName(discovered)]
  }

  // Filter dynamic protocols (ADB) by reachability
  if (shouldProbeAdb && protocols.includes('adb')) {
    const host = new URL(discovered.url).hostname
    const adbReachable = await probeAdbReachable(host)
    if (!adbReachable) {
      protocols = protocols.filter((p) => p !== 'adb')
    }
  }

  // Resolve model from plugin identification or static database
  const model =
    pluginId?.displayName !== undefined
      ? resolveModelFromPlugin(discovered, pluginId.displayName)
      : staticModel(discovered)

  return { discovered, displayName: resolvedName, model, protocols }
}

/** Identify all discovered devices in parallel. */
export async function identifyAll(
  devices: readonly DiscoveredModem[],
  options?: IdentifyOptions,
): Promise<IdentifiedDevice[]> {
  return Promise.all(devices.map((d) => identify(d, options)))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get model from static USB database (no runtime probe). */
function staticModel(d: DiscoveredModem): ModelInfo | undefined {
  const entry = d.entry ?? findModemEntry(d.vendorId, d.productId)
  const config = findProductConfig(entry, d.productId)
  return config?.model
}

/**
 * Attempt to resolve a ModelInfo from a plugin-provided display name.
 * Falls back to static model if no match.
 */
function resolveModelFromPlugin(d: DiscoveredModem, _displayName: string): ModelInfo | undefined {
  // The plugin's identify() could return a model directly in the future.
  // For now, fall back to static resolution.
  return staticModel(d)
}
