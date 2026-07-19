import { describe, expect, it } from 'vitest'
import {
  busLocationToLocationId,
  type IoregUsbDevice,
  parseIoregUsbDevices,
  selectIoregDevice,
  wholeDiskBsdName,
} from '../../src/discovery/ioreg.js'

/**
 * A realistic `ioreg -r -c IOUSBHostDevice -l -w0` fixture.
 *
 * Two IOUSBHostDevice subtrees:
 *  1. A storage-mode modem (VID 4817 / PID 5669) whose IOMedia descendant
 *     carries BSD Name disk4 (+ partition disk4s1).
 *  2. An UNRELATED USB SSD enclosure (VID 1234 / PID 5678) carrying disk8.
 *
 * The old flat parser located "idVendor = 4817" and then the first "BSD Name"
 * after it — which is disk4 here, but flips to disk8 the moment the SSD sorts
 * ahead in the dump. The tree parse must always keep disk8 with the SSD.
 */
const IOREG_FIXTURE = `+-o Modem@01100000  <class IOUSBHostDevice, id 0x100000abc, registered, matched, active, busy 0 (5 ms), retain 20>
  | {
  |   "idVendor" = 4817
  |   "idProduct" = 5669
  |   "locationID" = 17825792
  |   "USB Product Name" = "Mobile Connect"
  | }
  +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x100000abd, registered, active, retain 9>
    | {
    |   "bInterfaceClass" = 8
    | }
    +-o IOUSBMassStorageDriverNub  <class IOUSBMassStorageDriverNub, id 0x100000abe, registered, active, retain 6>
      | {
      |   "USB Interface Name" = "Mass Storage"
      | }
      +-o IOMediaBSDClient  <class IOMedia, id 0x100000abf, registered, active, retain 5>
        | {
        |   "BSD Name" = "disk4"
        |   "Whole" = Yes
        | }
        +-o disk4s1  <class IOMedia, id 0x100000ac0, registered, active, retain 4>
          | {
          |   "BSD Name" = "disk4s1"
          |   "Whole" = No
          | }
+-o SSD@02200000  <class IOUSBHostDevice, id 0x100000dd0, registered, matched, active, busy 0 (2 ms), retain 18>
  | {
  |   "idVendor" = 1234
  |   "idProduct" = 5678
  |   "locationID" = 35651584
  |   "USB Product Name" = "Portable SSD"
  | }
  +-o IOUSBHostInterface@0  <class IOUSBHostInterface, id 0x100000dd1, registered, active, retain 9>
    | {
    |   "bInterfaceClass" = 8
    | }
    +-o IOMediaBSDClient  <class IOMedia, id 0x100000dd2, registered, active, retain 5>
      | {
      |   "BSD Name" = "disk8"
      |   "Whole" = Yes
      | }
`

describe('parseIoregUsbDevices()', () => {
  it('attributes each BSD name to its owning USB device subtree', () => {
    const devices = parseIoregUsbDevices(IOREG_FIXTURE)
    expect(devices).toHaveLength(2)

    const [modem, ssd] = devices
    expect(modem?.idVendor).toBe(4817)
    expect(modem?.idProduct).toBe(5669)
    expect(modem?.locationID).toBe(17825792)
    expect(modem?.productName).toBe('Mobile Connect')
    expect(modem?.bsdNames).toEqual(['disk4', 'disk4s1'])

    expect(ssd?.idVendor).toBe(1234)
    expect(ssd?.bsdNames).toEqual(['disk8'])
  })

  it('never leaks an unrelated disk into a modem with no disk of its own', () => {
    // Modem with no storage subtree at all — must not inherit the SSD's disk8.
    const noDisk = `+-o Modem  <class IOUSBHostDevice, id 0x1, active, retain 1>
  | {
  |   "idVendor" = 4817
  |   "idProduct" = 5669
  | }
+-o SSD  <class IOUSBHostDevice, id 0x2, active, retain 1>
  | {
  |   "idVendor" = 1234
  |   "idProduct" = 5678
  | }
  +-o Media  <class IOMedia, id 0x3, active, retain 1>
    | {
    |   "BSD Name" = "disk8"
    | }
`
    const devices = parseIoregUsbDevices(noDisk)
    const modem = devices.find((d) => d.idVendor === 4817)
    expect(modem?.bsdNames).toEqual([])
  })

  it('skips device nodes missing idVendor/idProduct', () => {
    const partial = `+-o Hub  <class IOUSBHostDevice, id 0x1, active, retain 1>
  | {
  |   "locationID" = 1
  | }
`
    expect(parseIoregUsbDevices(partial)).toEqual([])
  })

  it('returns [] for empty output', () => {
    expect(parseIoregUsbDevices('')).toEqual([])
  })

  it('parses real ioreg branch-continuation (pipe) indentation', () => {
    // Real `ioreg -l` fills ancestor branch columns with "| " rather than spaces.
    // Depth must still be read correctly so the media node nests under the modem.
    const piped = [
      '+-o Modem  <class IOUSBHostDevice, id 0x1, active, retain 1>',
      '  | {',
      '  |   "idVendor" = 4817',
      '  |   "idProduct" = 5669',
      '  |   "locationID" = 17825792',
      '  | }',
      '  +-o Interface  <class IOUSBHostInterface, id 0x2, active, retain 1>',
      '  | | {',
      '  | |   "bInterfaceClass" = 8',
      '  | | }',
      '  | +-o Media  <class IOMedia, id 0x3, active, retain 1>',
      '  |     {',
      '  |       "BSD Name" = "disk7"',
      '  |     }',
    ].join('\n')

    const devices = parseIoregUsbDevices(piped)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.idVendor).toBe(4817)
    expect(devices[0]?.locationID).toBe(17825792)
    expect(devices[0]?.bsdNames).toEqual(['disk7'])
  })
})

describe('busLocationToLocationId()', () => {
  it('encodes bus byte and port nibbles like Apple locationID', () => {
    expect(busLocationToLocationId(1, [1])).toBe(0x01100000)
    expect(busLocationToLocationId(2, [2])).toBe(0x02200000)
    expect(busLocationToLocationId(20, [4, 3])).toBe(0x14430000)
    expect(busLocationToLocationId(1, [])).toBe(0x01000000)
  })

  it('caps at 7 port tiers and stays a uint32', () => {
    const loc = busLocationToLocationId(0xff, [1, 2, 3, 4, 5, 6, 7, 8])
    expect(loc).toBeGreaterThanOrEqual(0)
    expect(loc).toBe(loc >>> 0)
  })
})

describe('selectIoregDevice()', () => {
  const twin = (locationID: number, bsd: string[]): IoregUsbDevice => ({
    idVendor: 4817,
    idProduct: 5669,
    locationID,
    productName: 'Twin',
    bsdNames: bsd,
  })

  it('returns the sole candidate without needing a location', () => {
    const devices = [twin(0x01100000, ['disk4'])]
    expect(selectIoregDevice(devices, 4817, 5669)?.locationID).toBe(0x01100000)
  })

  it('returns undefined when no candidate matches', () => {
    expect(selectIoregDevice([twin(0x01100000, ['disk4'])], 9999, 1)).toBeUndefined()
  })

  it('disambiguates two identical modems by physical location', () => {
    const devices = [twin(0x01100000, ['disk4']), twin(0x02200000, ['disk9'])]
    const chosen = selectIoregDevice(devices, 4817, 5669, busLocationToLocationId(2, [2]))
    expect(chosen?.locationID).toBe(0x02200000)
    expect(chosen?.bsdNames).toEqual(['disk9'])
  })

  it('refuses (undefined) when two identical modems cannot be told apart', () => {
    const devices = [twin(0x01100000, ['disk4']), twin(0x02200000, ['disk9'])]
    // No location at all -> ambiguous.
    expect(selectIoregDevice(devices, 4817, 5669)).toBeUndefined()
    // Location matches neither -> still refuse rather than guess.
    const mismatch = selectIoregDevice(devices, 4817, 5669, busLocationToLocationId(9, [9]))
    expect(mismatch).toBeUndefined()
  })
})

describe('wholeDiskBsdName()', () => {
  it('prefers the whole disk over a partition', () => {
    const device: IoregUsbDevice = {
      idVendor: 1,
      idProduct: 1,
      locationID: undefined,
      productName: undefined,
      bsdNames: ['disk4s1', 'disk4'],
    }
    expect(wholeDiskBsdName(device)).toBe('disk4')
  })

  it('returns undefined when there is no disk', () => {
    const device: IoregUsbDevice = {
      idVendor: 1,
      idProduct: 1,
      locationID: undefined,
      productName: undefined,
      bsdNames: [],
    }
    expect(wholeDiskBsdName(device)).toBeUndefined()
  })
})
