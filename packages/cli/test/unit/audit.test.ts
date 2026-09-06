import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noopLogger } from 'cellary'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDeviceAudit } from '../../src/lib/audit.js'

describe('openDeviceAudit', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cellary-cli-audit-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes device-stamped JSONL records under CELLARY_AUDIT_DIR', () => {
    const audit = openDeviceAudit('/dev/ttyUSB0', noopLogger, { CELLARY_AUDIT_DIR: dir })

    audit.sink.record({ timestamp: 1000, protocol: 'at', direction: 'tx', text: 'AT+CSQ' })
    audit.sink.record({ timestamp: 1001, protocol: 'at', direction: 'rx', text: '+CSQ: 18,99' })
    audit.close()

    const lines = readFileSync(join(dir, 'comms.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))

    expect(lines).toEqual([
      { ts: 1000, deviceId: '/dev/ttyUSB0', protocol: 'at', dir: 'tx', text: 'AT+CSQ' },
      { ts: 1001, deviceId: '/dev/ttyUSB0', protocol: 'at', dir: 'rx', text: '+CSQ: 18,99' },
    ])
  })

  it('derives the default location from XDG_STATE_HOME', () => {
    const audit = openDeviceAudit('dev-1', noopLogger, { XDG_STATE_HOME: dir })
    audit.sink.record({ timestamp: 1, protocol: 'at', direction: 'tx', text: 'AT' })
    audit.close()

    const content = readFileSync(join(dir, 'cellary', 'audit', 'comms.jsonl'), 'utf8')
    expect(content).toContain('"deviceId":"dev-1"')
  })

  it('rejects an empty CELLARY_AUDIT_DIR instead of guessing a path', () => {
    expect(() => openDeviceAudit('dev-1', noopLogger, { CELLARY_AUDIT_DIR: '' })).toThrow()
  })
})
