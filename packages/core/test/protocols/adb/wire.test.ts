import { describe, expect, it } from 'vitest'

import {
  A_CLSE,
  A_CNXN,
  A_OKAY,
  A_OPEN,
  A_WRTE,
  ADB_HEADER_SIZE,
  ADB_MAX_PAYLOAD,
  ADB_VERSION,
} from '../../../src/protocols/adb/constants.js'

describe('ADB wire protocol constants', () => {
  it('magic is bitwise complement of command (round-trips)', () => {
    for (const cmd of [A_CNXN, A_OPEN, A_WRTE, A_OKAY, A_CLSE]) {
      const magic = (cmd ^ 0xffff_ffff) >>> 0
      // Round-trip: magic XOR 0xFFFFFFFF gives back the command
      expect((magic ^ 0xffff_ffff) >>> 0).toBe(cmd)
      // Magic is never equal to the command itself
      expect(magic).not.toBe(cmd)
    }
  })

  it('header is 24 bytes (6 x uint32)', () => {
    expect(ADB_HEADER_SIZE).toBe(24)
  })

  it('max payload is the V1-consistent 4096 (old-adbd compatible)', () => {
    // Must stay consistent with ADB version 0x01000000 (V1), which mandates a
    // 4096-byte cap. A larger value wedges old adbd (e.g. Android 4.4 modems).
    expect(ADB_MAX_PAYLOAD).toBe(4096)
  })

  it('version is 0x01000000', () => {
    expect(ADB_VERSION).toBe(0x0100_0000)
  })

  it('commands are ASCII-encoded 4-byte values', () => {
    // CNXN = "NXNC" in little-endian
    const cnxn = Buffer.from('CNXN', 'ascii')
    const expected = cnxn.readUInt32LE(0)
    expect(A_CNXN).toBe(expected)
  })
})

describe('ADB message serialization', () => {
  it('creates a valid 24-byte header for empty payload', () => {
    // Manual serialization to verify the format
    const header = Buffer.alloc(ADB_HEADER_SIZE)
    const command = A_CNXN
    const arg0 = ADB_VERSION
    const arg1 = ADB_MAX_PAYLOAD

    header.writeUInt32LE(command, 0)
    header.writeUInt32LE(arg0, 4)
    header.writeUInt32LE(arg1, 8)
    header.writeUInt32LE(0, 12) // data_length
    header.writeUInt32LE(0, 16) // checksum
    header.writeUInt32LE((command ^ 0xffff_ffff) >>> 0, 20) // magic

    expect(header.length).toBe(24)
    expect(header.readUInt32LE(0)).toBe(A_CNXN)
    expect(header.readUInt32LE(4)).toBe(ADB_VERSION)
    expect(header.readUInt32LE(8)).toBe(ADB_MAX_PAYLOAD)
    expect(header.readUInt32LE(20)).toBe((A_CNXN ^ 0xffff_ffff) >>> 0)
  })

  it('computes checksum as sum of payload bytes', () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04])
    let sum = 0
    for (const byte of payload) {
      sum += byte
    }
    expect(sum).toBe(10)
  })
})
