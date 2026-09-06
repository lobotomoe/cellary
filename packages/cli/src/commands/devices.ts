import { type DiscoveredModem, type IdentifiedDevice, identifyAll } from 'cellary'
import { defineCommand } from 'citty'

import { withBackend } from '../backend/resolve.js'
import { verboseArg } from '../lib/cli-args.js'
import { busLocation, formatVidPid } from '../lib/device-format.js'
import { withErrorHandling } from '../lib/errors.js'
import { formatTable } from '../lib/format.js'
import { findModemInterface } from '../lib/network-interface.js'

// ── Types ───────────────────────────────────────────────────────────────────

/** An identified device whose discovered modem has USB bus topology (not serial). */
interface UsbIdentified extends IdentifiedDevice {
  readonly discovered: DiscoveredModem & {
    readonly busNumber: number
    readonly portNumbers: readonly number[]
  }
}

/** Type guard: does this identified device have USB bus topology? */
function isUsbIdentified(id: IdentifiedDevice): id is UsbIdentified {
  return id.discovered.mode !== 'serial'
}

// ── Connection description ──────────────────────────────────────────────────

/** Build a human-readable connection description from an identified device. */
function connectionDescription(id: IdentifiedDevice): string {
  const d = id.discovered
  switch (d.mode) {
    case 'emergency':
      return 'BootROM (emergency mode)'
    case 'download':
      return 'Download mode (firmware flash)'
    case 'storage':
      return 'Storage -> sudo cellary init'
    case 'modem-usb':
      return 'AT via USB'
    case 'serial':
      return `Serial (${d.path})`
    case 'http': {
      const host = new URL(d.url).host
      const protoStr = id.protocols.join(' + ')
      const iface = findModemInterface(new URL(d.url).hostname)
      const location = iface !== undefined ? `(${host}) via ${iface.name}` : `(${host})`
      return protoStr.length > 0 ? `${protoStr} ${location}` : `HTTP ${location}`
    }
  }
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/** Sort comparator: bus number first, then port path. Serial devices last. */
function compareByBusLocation(a: DiscoveredModem, b: DiscoveredModem): number {
  if (a.mode === 'serial' && b.mode === 'serial') return 0
  if (a.mode === 'serial') return 1
  if (b.mode === 'serial') return -1

  if (a.busNumber !== b.busNumber) return a.busNumber - b.busNumber

  const aPath = a.portNumbers
  const bPath = b.portNumbers
  const len = Math.min(aPath.length, bPath.length)
  for (let i = 0; i < len; i++) {
    const aPort = aPath[i] ?? 0
    const bPort = bPath[i] ?? 0
    if (aPort !== bPort) return aPort - bPort
  }
  return aPath.length - bPath.length
}

// ── Tree view ───────────────────────────────────────────────────────────────

/** Format a single device line for tree view. */
function deviceLine(id: IdentifiedDevice, showIds: boolean): string {
  const d = id.discovered
  const conn = connectionDescription(id)
  if (showIds) {
    return `${id.displayName}  ${formatVidPid(d.vendorId, d.productId)}  ${conn}`
  }
  return `${id.displayName}  ${conn}`
}

/**
 * Render devices as a USB topology tree grouped by bus and hub.
 *
 * Devices sharing a common port prefix are grouped under a hub node.
 * Serial devices are listed separately at the end.
 */
function renderTree(identified: readonly IdentifiedDevice[], showIds: boolean): string {
  const lines: string[] = []

  // Separate serial devices (no bus topology)
  const usbDevices: UsbIdentified[] = []
  const serialDevices: IdentifiedDevice[] = []

  for (const id of identified) {
    if (isUsbIdentified(id)) {
      usbDevices.push(id)
    } else {
      serialDevices.push(id)
    }
  }

  // Group by bus
  const byBus = new Map<number, UsbIdentified[]>()
  for (const id of usbDevices) {
    const bus = byBus.get(id.discovered.busNumber)
    if (bus !== undefined) {
      bus.push(id)
    } else {
      byBus.set(id.discovered.busNumber, [id])
    }
  }

  const busEntries = [...byBus.entries()].sort(([a], [b]) => a - b)
  for (const [busNum, busDevices] of busEntries) {
    lines.push(`bus${busNum}`)

    // Group by hub prefix (portNumbers without last element)
    const byHub = new Map<string, UsbIdentified[]>()
    for (const id of busDevices) {
      const ports = id.discovered.portNumbers
      const hubKey = ports.length > 2 ? ports.slice(0, -1).join('.') : ''
      const group = byHub.get(hubKey)
      if (group !== undefined) {
        group.push(id)
      } else {
        byHub.set(hubKey, [id])
      }
    }

    const hubEntries = [...byHub.entries()].sort(([a], [b]) => a.localeCompare(b))
    for (let hi = 0; hi < hubEntries.length; hi++) {
      const entry = hubEntries[hi]
      if (entry === undefined) continue
      const [hubKey, hubDevices] = entry
      const isLastHub = hi === hubEntries.length - 1

      if (hubKey === '') {
        // Direct devices on the bus (no hub)
        for (let di = 0; di < hubDevices.length; di++) {
          const id = hubDevices[di]
          if (id === undefined) continue
          const isLast = isLastHub && di === hubDevices.length - 1
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '
          lines.push(`  ${connector}${deviceLine(id, showIds)}`)
        }
      } else {
        // Hub group
        const hubConnector = isLastHub ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '
        lines.push(`  ${hubConnector}hub ${hubKey}`)

        const indent = isLastHub ? '      ' : '\u2502     '
        for (let di = 0; di < hubDevices.length; di++) {
          const id = hubDevices[di]
          if (id === undefined) continue
          const isLast = di === hubDevices.length - 1
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '
          lines.push(`${indent}${connector}${deviceLine(id, showIds)}`)
        }
      }
    }
  }

  // Serial devices at the end
  for (const id of serialDevices) {
    lines.push(deviceLine(id, showIds))
  }

  return lines.join('\n')
}

// ── Table row helpers ───────────────────────────────────────────────────────

function idRow(id: IdentifiedDevice, multiDevice: boolean): string[] {
  const d = id.discovered
  const vidPid = formatVidPid(d.vendorId, d.productId)
  const conn = connectionDescription(id)
  if (multiDevice) {
    return [vidPid, id.displayName, busLocation(d), conn]
  }
  return [vidPid, id.displayName, conn]
}

function nameRow(id: IdentifiedDevice, multiDevice: boolean): string[] {
  const conn = connectionDescription(id)
  if (multiDevice) {
    return [id.displayName, busLocation(id.discovered), conn]
  }
  return [id.displayName, conn]
}

// ── Command ─────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'devices',
    description: 'List connected modems (USB and serial)',
  },
  args: {
    ...verboseArg,
    ids: {
      type: 'boolean',
      description: 'Show USB vendor/product IDs',
      default: false,
    },
    tree: {
      type: 'boolean',
      alias: 't',
      description: 'Show USB topology as a tree',
      default: false,
    },
  },
  run({ args }) {
    return withErrorHandling(async () => {
      await withBackend(async (backend) => {
        const unsorted = await backend.listDevices()
        // Sort by bus location so devices on the same hub appear adjacent
        const devices = [...unsorted].sort(compareByBusLocation)

        if (devices.length === 0) {
          process.stdout.write('No modems found.\n')
          process.stdout.write(
            '  Tip: USB modems may require elevated privileges -- try: sudo cellary devices\n',
          )
          return
        }

        // Identify all devices in parallel (ADB probe, model name resolution)
        const identified = await identifyAll(devices)

        if (args.tree) {
          process.stdout.write(renderTree(identified, args.ids))
          process.stdout.write('\n')
          return
        }

        // Always show bus location when multiple devices are present
        const multiDevice = devices.length > 1

        if (args.ids) {
          const headers = multiDevice
            ? ['VID:PID', 'Device', 'Port', 'Connection']
            : ['VID:PID', 'Device', 'Connection']
          const rows = identified.map((id) => idRow(id, multiDevice))
          process.stdout.write(formatTable(headers, rows))
        } else {
          const headers = multiDevice ? ['Device', 'Port', 'Connection'] : ['Device', 'Connection']
          const rows = identified.map((id) => nameRow(id, multiDevice))
          process.stdout.write(formatTable(headers, rows))
        }

        process.stdout.write('\n')
      })
    })
  },
})
