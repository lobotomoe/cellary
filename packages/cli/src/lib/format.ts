/**
 * Output formatting helpers for CLI commands.
 *
 * All output is plain text, designed to be clean and pipeable.
 * No color dependencies -- just string alignment.
 */

// ── Label/Value pairs ───────────────────────────────────────────────────────

/**
 * Format a list of label-value pairs as aligned columns.
 *
 * ```
 * Manufacturer  Huawei
 * Model         E3372
 * IMEI          867232040012345
 * ```
 */
export function formatLabels(pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return ''

  const maxLabel = pairs.reduce((max, [label]) => Math.max(max, label.length), 0)
  const PAD = 2

  return pairs.map(([label, value]) => `${label.padEnd(maxLabel + PAD)}${value}`).join('\n')
}

// ── Tables ──────────────────────────────────────────────────────────────────

/**
 * Format rows as a table with column headers.
 *
 * ```
 * Vendor  Product  Name    Mode
 * 12d1    1506     Huawei  modem
 * ```
 */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) return ''

  const columnCount = headers.length
  const widths: number[] = headers.map((h) => h.length)

  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      const cell = row[i]
      if (cell !== undefined) {
        widths[i] = Math.max(widths[i] ?? 0, cell.length)
      }
    }
  }

  const PAD = 2
  const formatRow = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd((widths[i] ?? 0) + PAD)).join('')

  const headerLine = formatRow(headers)
  const dataLines = rows.map(formatRow)

  return [headerLine, ...dataLines].join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Format a hex number as a zero-padded 4-digit string: 0x12d1 -> "12d1" */
export function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

// ── Data formatting ─────────────────────────────────────────────────────────

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
const BYTES_PER_UNIT = 1024

/** Format a byte count as a human-readable string: 1234567 -> "1.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  let value = Math.abs(bytes)
  let unitIndex = 0
  while (value >= BYTES_PER_UNIT && unitIndex < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT
    unitIndex++
  }
  const unit = SIZE_UNITS[unitIndex] ?? 'B'
  const formatted = unitIndex === 0 ? `${value}` : value.toFixed(1).replace(/\.0$/, '')
  return bytes < 0 ? `-${formatted} ${unit}` : `${formatted} ${unit}`
}

/** Format a byte-per-second rate: 12800 -> "12.5 KB/s" */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400

/** Format a duration in seconds as a human-readable string: 8100 -> "2h 15m" */
export function formatDuration(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`

  const days = Math.floor(seconds / SECONDS_PER_DAY)
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR)
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)

  return parts.join(' ') || '0m'
}

// ── Protocol formatting ──────────────────────────────────────────────────────

const PROTOCOL_DISPLAY_NAMES: Record<string, string> = {
  at: 'AT',
}

/** Human-readable label for a protocol adapter kind: 'at' -> 'AT', 'mifi' -> 'MIFI'. */
export function protocolLabel(kind: string): string {
  return PROTOCOL_DISPLAY_NAMES[kind] ?? kind.toUpperCase()
}

const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  network: 'Net',
  sms: 'SMS',
  sim: 'SIM',
  device: 'Dev',
  voice: 'Voice',
  ussd: 'USSD',
  stk: 'STK',
}

/**
 * Format service routing as a human-readable string grouped by protocol.
 * Shows reasons only for contested services (where multiple adapters compete).
 *
 * Example: "HTTP -> Net (rich signal)  |  AT -> SMS, SIM, Dev, Voice, USSD (no auth)"
 *
 * @param routing - Map of service name to route info (from Modem.serviceRouting)
 * @param protocols - Priority-ordered adapter kinds (from Modem.protocols)
 */
export function formatServiceRouting(
  routing: Readonly<Record<string, { adapter: string; reason: string; contested: boolean }>>,
  protocols: readonly string[],
): string {
  // Collect groups in adapter priority order
  const groups = new Map<string, string[]>()
  for (const kind of protocols) {
    if (!groups.has(kind)) groups.set(kind, [])
  }

  for (const [svc, info] of Object.entries(routing)) {
    const label = SERVICE_DISPLAY_NAMES[svc]
    if (label === undefined) continue
    const group = groups.get(info.adapter)
    if (group === undefined) continue
    const suffix = info.contested && info.reason !== '' ? ` (${info.reason})` : ''
    group.push(`${label}${suffix}`)
  }

  return [...groups.entries()]
    .filter(([, svcs]) => svcs.length > 0)
    .map(([kind, svcs]) => `${protocolLabel(kind)} -> ${svcs.join(', ')}`)
    .join('  |  ')
}
