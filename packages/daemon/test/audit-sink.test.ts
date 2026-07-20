import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileAuditSink } from '../src/audit-sink.js'

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

  function readLines(): Record<string, unknown>[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
  }

  it('appends one JSONL line per record, stamped with the deviceId', () => {
    sink.append('dev-1', { timestamp: 1000, protocol: 'at', direction: 'tx', text: 'AT+CSQ' })
    sink.append('dev-1', { timestamp: 1001, protocol: 'at', direction: 'rx', text: '+CSQ: 18,99' })

    const lines = readLines()
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

    expect(readLines().map((l) => l.deviceId)).toEqual(['dev-1', 'dev-2'])
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

    const [withOutcome, withoutOutcome] = readLines()
    expect(withOutcome).toMatchObject({ outcome: 'timeout', text: '' })
    expect(withoutOutcome).not.toHaveProperty('outcome')
  })

  it('appends rather than truncates when reopened', () => {
    sink.append('dev-1', { timestamp: 1, protocol: 'at', direction: 'tx', text: 'first' })

    const reopened = new FileAuditSink(file)
    reopened.append('dev-1', { timestamp: 2, protocol: 'at', direction: 'tx', text: 'second' })
    reopened.close()

    expect(readLines().map((l) => l.text)).toEqual(['first', 'second'])
  })
})
