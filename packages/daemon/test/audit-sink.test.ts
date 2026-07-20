import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileAuditSink } from '../src/audit-sink.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('FileAuditSink', () => {
  let dir: string
  let file: string
  let sink: FileAuditSink

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cellary-audit-'))
    file = join(dir, 'comms.jsonl')
    sink = new FileAuditSink(file)
  })

  afterEach(() => {
    sink.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function readLines(path: string): Record<string, unknown>[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
  }

  /** All records across the active file and every rotated file for a base path. */
  function readAllRecords(basePath: string): Record<string, unknown>[] {
    const base = basePath.slice(dir.length + 1)
    const files = readdirSync(dir).filter((n) => n === base || n.startsWith(`${base}.`))
    return files.flatMap((n) => (existsSync(join(dir, n)) ? readLines(join(dir, n)) : []))
  }

  function rotatedFiles(base: string): string[] {
    return readdirSync(dir).filter((n) => n.startsWith(`${base}.`))
  }

  it('appends one JSONL line per record, stamped with the deviceId', () => {
    sink.append('dev-1', { timestamp: 1000, protocol: 'at', direction: 'tx', text: 'AT+CSQ' })
    sink.append('dev-1', { timestamp: 1001, protocol: 'at', direction: 'rx', text: '+CSQ: 18,99' })

    const lines = readLines(file)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      ts: 1000,
      deviceId: 'dev-1',
      protocol: 'at',
      dir: 'tx',
      text: 'AT+CSQ',
    })
    expect(lines[1]).toMatchObject({ deviceId: 'dev-1', dir: 'rx', text: '+CSQ: 18,99' })
  })

  it('interleaves multiple devices in one stream', () => {
    sink.append('dev-1', { timestamp: 1, protocol: 'at', direction: 'tx', text: 'A' })
    sink.append('dev-2', { timestamp: 2, protocol: 'at', direction: 'tx', text: 'B' })

    expect(readLines(file).map((l) => l.deviceId)).toEqual(['dev-1', 'dev-2'])
  })

  it('includes outcome only when present', () => {
    sink.append('dev-1', {
      timestamp: 3,
      protocol: 'at',
      direction: 'rx',
      text: '',
      outcome: 'timeout',
    })
    sink.append('dev-1', { timestamp: 4, protocol: 'at', direction: 'tx', text: 'AT' })

    const [withOutcome, withoutOutcome] = readLines(file)
    expect(withOutcome).toMatchObject({ outcome: 'timeout', text: '' })
    expect(withoutOutcome).not.toHaveProperty('outcome')
  })

  it('appends rather than truncates when reopened', () => {
    sink.append('dev-1', { timestamp: 1, protocol: 'at', direction: 'tx', text: 'first' })

    const reopened = new FileAuditSink(file)
    reopened.append('dev-1', { timestamp: 2, protocol: 'at', direction: 'tx', text: 'second' })
    reopened.close()

    expect(readLines(file).map((l) => l.text)).toEqual(['first', 'second'])
  })

  it('close is idempotent', () => {
    sink.append('dev-1', { timestamp: 1, protocol: 'at', direction: 'tx', text: 'x' })
    sink.close()
    expect(() => sink.close()).not.toThrow()
  })

  describe('rotation', () => {
    it('rotates past the size cap without losing any records', () => {
      const rotFile = join(dir, 'rot.jsonl')
      const rot = new FileAuditSink(rotFile, { maxBytes: 80 })

      const total = 12
      for (let i = 0; i < total; i++) {
        rot.append('dev-1', { timestamp: i, protocol: 'at', direction: 'tx', text: `line-${i}` })
      }
      rot.close()

      // At least one rotation happened, and the active file still exists.
      expect(rotatedFiles('rot.jsonl').length).toBeGreaterThanOrEqual(1)
      expect(existsSync(rotFile)).toBe(true)

      // Every record survives, in order, across active + rotated files.
      const texts = readAllRecords(rotFile).map((r) => r.text)
      expect(texts).toHaveLength(total)
      expect(texts).toEqual(Array.from({ length: total }, (_, i) => `line-${i}`))
    })
  })

  describe('retention', () => {
    it('prunes rotated files older than the window', () => {
      let clock = Date.now()
      const rotFile = join(dir, 'aged.jsonl')

      const s1 = new FileAuditSink(rotFile, {
        maxBytes: 60,
        retentionMs: DAY_MS,
        now: () => clock,
      })
      for (let i = 0; i < 10; i++) {
        s1.append('dev-1', { timestamp: i, protocol: 'at', direction: 'tx', text: `x-${i}` })
      }
      s1.close()
      expect(rotatedFiles('aged.jsonl').length).toBeGreaterThanOrEqual(1)

      // Two days later, a fresh sink prunes on startup: rotated files (real
      // mtime ~ now) are older than the 1-day window relative to the clock.
      clock += 2 * DAY_MS
      const s2 = new FileAuditSink(rotFile, { retentionMs: DAY_MS, now: () => clock })
      s2.close()

      expect(rotatedFiles('aged.jsonl')).toHaveLength(0)
      // The active file is never pruned.
      expect(existsSync(rotFile)).toBe(true)
    })

    it('keeps rotated files still within the window', () => {
      let clock = Date.now()
      const rotFile = join(dir, 'fresh.jsonl')
      const retentionMs = 30 * DAY_MS

      const s1 = new FileAuditSink(rotFile, { maxBytes: 60, retentionMs, now: () => clock })
      for (let i = 0; i < 10; i++) {
        s1.append('dev-1', { timestamp: i, protocol: 'at', direction: 'tx', text: `y-${i}` })
      }
      s1.close()
      const before = rotatedFiles('fresh.jsonl')
      expect(before.length).toBeGreaterThanOrEqual(1)

      // One day later: well within the 30-day window, so nothing is pruned.
      clock += DAY_MS
      const s2 = new FileAuditSink(rotFile, { retentionMs, now: () => clock })
      s2.close()

      expect(rotatedFiles('fresh.jsonl')).toEqual(before)
    })
  })
})
