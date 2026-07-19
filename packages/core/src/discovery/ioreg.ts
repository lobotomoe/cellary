/**
 * Structured parser for macOS `ioreg` USB device output.
 *
 * `ioreg -l` prints the IOKit registry as an indented tree. Each node looks like
 *
 *     <indent>+-o <name>  <class <ClassName>, id 0x..., ...>
 *     <indent>| {
 *     <indent>|   "idVendor" = 4817
 *     <indent>| }
 *     <indent>+-o <child> ...
 *
 * A USB modem's `BSD Name` (the disk that `diskutil eject` targets during mode
 * switching) does NOT live on the IOUSBHostDevice node — it lives on a nested
 * IOMedia descendant. Attributing every idVendor/idProduct and every descendant
 * BSD Name to its OWNING device node, structurally, is what lets mode switching
 * eject the correct disk.
 *
 * The previous flat scan paired a VID found anywhere in the dump with the first
 * BSD Name found after it — which can belong to a completely different device
 * (e.g. the user's boot SSD). Ejecting the wrong disk is data loss, so this
 * parse walks the tree by indentation depth and keeps each device's subtree
 * separate.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** USB class name in the IOKit registry for a USB device (or hub). */
const USB_DEVICE_CLASS = 'IOUSBHostDevice'

/** ioreg indents the tree by exactly two columns per level (`  ` or `| `). */
const INDENT_WIDTH_PER_LEVEL = 2

/** libusb caps the USB port path at 7 tiers. */
const MAX_PORT_DEPTH = 7

/** Each port tier occupies one 4-bit nibble; tier 0 sits just below the bus byte. */
const NIBBLE_BITS = 4
const FIRST_PORT_SHIFT = 20

const IOREG_ARGS = ['-r', '-c', USB_DEVICE_CLASS, '-l', '-w0'] as const
const IOREG_TIMEOUT_MS = 5000
const IOREG_MAX_BUFFER = 8 * 1024 * 1024

// A node header line: leading indent (spaces/pipes) then `+-o <name>  <class X,`.
const NODE_HEADER = /^([ |]*)\+-o .*?<class ([A-Za-z0-9_]+),/
const BSD_NAME = /"BSD Name" = "([^"]+)"/g
const WHOLE_DISK = /^disk\d+$/

/** A USB device parsed from the IOKit registry, with its subtree's disks. */
export interface IoregUsbDevice {
  readonly idVendor: number
  readonly idProduct: number
  /**
   * Apple locationID (bus + port path encoded into 32 bits). Undefined when the
   * registry entry omits it. Used to disambiguate two identical (same VID:PID)
   * modems by physical port.
   */
  readonly locationID: number | undefined
  /** USB product name string, when present. */
  readonly productName: string | undefined
  /** BSD disk names (e.g. "disk8", "disk8s1") mounted anywhere in this device's subtree. */
  readonly bsdNames: readonly string[]
}

interface MutableDevice {
  idVendor: number
  idProduct: number
  locationID: number | undefined
  productName: string | undefined
  bsdNames: string[]
}

/** One `+-o` node: its depth, IOKit class, and its own property-block text. */
interface RawNode {
  readonly depth: number
  readonly cls: string
  readonly block: string
}

/**
 * Parse `ioreg -l` output into the USB devices it describes, each carrying the
 * BSD disk names found in its own subtree.
 */
export function parseIoregUsbDevices(output: string): IoregUsbDevice[] {
  const nodes = segmentNodes(output)
  return attributeDevices(nodes)
}

/** Run `ioreg` and parse its output. Returns [] on any platform but darwin. */
export async function readIoregUsbDevices(): Promise<IoregUsbDevice[]> {
  if (process.platform !== 'darwin') return []
  const { stdout } = await execFileAsync('ioreg', [...IOREG_ARGS], {
    encoding: 'utf-8',
    timeout: IOREG_TIMEOUT_MS,
    maxBuffer: IOREG_MAX_BUFFER,
  })
  return parseIoregUsbDevices(stdout)
}

/**
 * Reconstruct the Apple locationID for a device from its libusb bus location.
 *
 * libusb on macOS derives busNumber/portNumbers FROM the locationID:
 *   busNumber   = (locationID >> 24) & 0xff
 *   portNumbers = successive nibbles below the bus byte, MSB first
 * so the inverse is a bus byte followed by one nibble per port tier.
 * See libusb `os/darwin_usb.c` (darwin_device_get_port_path).
 */
export function busLocationToLocationId(busNumber: number, portNumbers: readonly number[]): number {
  let location = (busNumber & 0xff) << 24
  const tiers = Math.min(portNumbers.length, MAX_PORT_DEPTH)
  for (let i = 0; i < tiers; i++) {
    const port = portNumbers[i]
    if (port === undefined) break
    location |= (port & 0xf) << (FIRST_PORT_SHIFT - i * NIBBLE_BITS)
  }
  return location >>> 0
}

/**
 * Pick the single USB device to act on for a (vendor, product) pair, optionally
 * disambiguated by physical bus location.
 *
 * Returns undefined when the target is ambiguous — no candidate, or two
 * identical modems that a missing/mismatched location can't tell apart. Callers
 * must treat undefined as "refuse to act": ejecting or switching the wrong one
 * of two identical devices is worse than asking the user to retry.
 */
export function selectIoregDevice(
  devices: readonly IoregUsbDevice[],
  vendorId: number,
  productId: number,
  expectedLocationId?: number,
): IoregUsbDevice | undefined {
  const candidates = devices.filter((d) => d.idVendor === vendorId && d.idProduct === productId)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) return undefined

  // Multiple identical devices: only a physical-location match can disambiguate.
  if (expectedLocationId === undefined) return undefined
  const located = candidates.filter((d) => d.locationID === expectedLocationId)
  return located.length === 1 ? located[0] : undefined
}

/**
 * The whole-disk BSD name (e.g. "disk8", not "disk8s1") to eject for a device,
 * or undefined when the device has no disk in its subtree.
 */
export function wholeDiskBsdName(device: IoregUsbDevice): string | undefined {
  const wholeDisks = device.bsdNames.filter((name) => WHOLE_DISK.test(name))
  // Fall back to the shortest name (partitions are longer than their parent disk).
  const sorted = [...(wholeDisks.length > 0 ? wholeDisks : device.bsdNames)].sort(
    (a, b) => a.length - b.length,
  )
  return sorted[0]
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Split the dump into nodes, each with its depth, class, and own property block. */
function segmentNodes(output: string): RawNode[] {
  const nodes: RawNode[] = []
  let depth = 0
  let cls = ''
  let blockLines: string[] = []
  let open = false

  const flush = () => {
    if (open) nodes.push({ depth, cls, block: blockLines.join('\n') })
  }

  for (const line of output.split('\n')) {
    const [, indent, className] = NODE_HEADER.exec(line) ?? []
    if (indent !== undefined && className !== undefined) {
      flush()
      depth = indent.length / INDENT_WIDTH_PER_LEVEL
      cls = className
      blockLines = []
      open = true
      continue
    }
    if (open) blockLines.push(line)
  }
  flush()
  return nodes
}

/** Walk nodes, attaching each subtree's BSD names to its enclosing USB device. */
function attributeDevices(nodes: readonly RawNode[]): IoregUsbDevice[] {
  const devices: IoregUsbDevice[] = []
  const stack: Array<{ depth: number; device: MutableDevice }> = []

  for (const node of nodes) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top !== undefined && top.depth >= node.depth) stack.pop()
      else break
    }

    if (node.cls === USB_DEVICE_CLASS) {
      const idVendor = readIntProp(node.block, 'idVendor')
      const idProduct = readIntProp(node.block, 'idProduct')
      if (idVendor === undefined || idProduct === undefined) continue

      const device: MutableDevice = {
        idVendor,
        idProduct,
        locationID: readIntProp(node.block, 'locationID'),
        productName: readStringProp(node.block, 'USB Product Name'),
        bsdNames: readBsdNames(node.block),
      }
      devices.push(device)
      stack.push({ depth: node.depth, device })
      continue
    }

    // Non-USB descendant (IOMedia, storage driver, ...): its BSD names belong to
    // the nearest enclosing USB device.
    const enclosing = stack[stack.length - 1]
    if (enclosing !== undefined) {
      enclosing.device.bsdNames.push(...readBsdNames(node.block))
    }
  }

  return devices
}

function readIntProp(block: string, key: string): number | undefined {
  const match = new RegExp(`"${key}" = (\\d+)`).exec(block)
  const [, value] = match ?? []
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function readStringProp(block: string, key: string): string | undefined {
  const match = new RegExp(`"${key}" = "([^"]*)"`).exec(block)
  const [, value] = match ?? []
  return value
}

function readBsdNames(block: string): string[] {
  const names: string[] = []
  for (const [, name] of block.matchAll(BSD_NAME)) {
    if (name !== undefined) names.push(name)
  }
  return names
}
