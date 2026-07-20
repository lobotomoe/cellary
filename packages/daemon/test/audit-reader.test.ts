import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuditRecord } from 'cellary'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditReader } from '../src/audit-reader.js'
import { FileAuditSink } from '../src/audit-sink.js'

function txRecord(ts: number, text: string): AuditRecord {
  return { timestamp: ts, protocol: 'at', direction: 'tx', text }
}

describe('AuditReader', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cellary-audit-read-'))
    file = join(dir, 'comms.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the most recent records, oldest-first', () => {
    const sink = new FileAuditSink(file)
    for (let i = 0; i < 20; i++) sink.append('dev-1', txRecord(i, `line-${i}`))
    sink.close()

    const tail = new AuditReader(file).tail({ limit: 5 })
    expect(tail.map((r) => r.ts)).toEqual([15, 16, 17, 18, 19])
    expect(tail.every((r) => r.deviceId === 'dev-1')).toBe(true)
  })

  it('filters by deviceId', () => {
    const sink = new FileAuditSink(file)
    for (let i = 0; i < 10; i++) {
      sink.append(i % 2 === 0 ? 'dev-a' : 'dev-b', txRecord(i, `t-${i}`))
    }
    sink.close()

    const tail = new AuditReader(file).tail({ deviceId: 'dev-a', limit: 3 })
    expect(tail.map((r) => r.ts)).toEqual([4, 6, 8])
    expect(tail.every((r) => r.deviceId === 'dev-a')).toBe(true)
  })

  it('reassembles a tail that spans rotated files in order', () => {
    // Tiny cap forces many rotations, so 20 records land across active + rotated.
    const sink = new FileAuditSink(file, { maxBytes: 80 })
    for (let i = 0; i < 20; i++) sink.append('dev-1', txRecord(i, `r-${i}`))
    sink.close()

    const all = new AuditReader(file).tail({ limit: 100 })
    expect(all.map((r) => r.ts)).toEqual(Array.from({ length: 20 }, (_, i) => i))

    const last7 = new AuditReader(file).tail({ limit: 7 })
    expect(last7.map((r) => r.ts)).toEqual([13, 14, 15, 16, 17, 18, 19])
  })

  it('skips malformed lines', () => {
    const sink = new FileAuditSink(file)
    sink.append('dev-1', txRecord(1, 'ok'))
    sink.close()

    // A torn write and a well-formed late record appended out-of-band.
    appendFileSync(file, 'this is not json\n')
    appendFileSync(file, '{"ts":true,"deviceId":5}\n') // valid JSON, wrong shape
    appendFileSync(
      file,
      `${JSON.stringify({ ts: 2, deviceId: 'dev-1', protocol: 'at', dir: 'rx', text: 'late' })}\n`,
    )

    const tail = new AuditReader(file).tail()
    expect(tail.map((r) => r.ts)).toEqual([1, 2])
    expect(tail.map((r) => r.text)).toEqual(['ok', 'late'])
  })

  it('returns nothing for a log that does not exist yet', () => {
    const tail = new AuditReader(join(dir, 'absent.jsonl')).tail({ limit: 10 })
    expect(tail).toEqual([])
  })

  it('drops the partial first line when the tail window starts mid-file', () => {
    const total = 8
    const sink = new FileAuditSink(file)
    for (let i = 0; i < total; i++) sink.append('dev-1', txRecord(i, `payload-${i}`))
    sink.close()

    // A small window cannot hold all records and starts mid-line.
    const tail = new AuditReader(file, { tailWindowBytes: 200 }).tail({ limit: 100 })

    expect(tail.length).toBeGreaterThanOrEqual(1)
    expect(tail.length).toBeLessThan(total)
    // Whatever survives is a clean, contiguous suffix -- no corrupt fragment.
    const tsValues = tail.map((r) => r.ts)
    const expected = Array.from({ length: total }, (_, i) => i).slice(-tail.length)
    expect(tsValues).toEqual(expected)
  })
})
