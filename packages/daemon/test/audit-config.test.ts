import { describe, expect, it } from 'vitest'

import { resolveAuditFile } from '../src/audit-config.js'

describe('resolveAuditFile', () => {
  it('defaults to ~/.local/state/cellary/audit/comms.jsonl', () => {
    expect(resolveAuditFile({}, '/home/op')).toBe('/home/op/.local/state/cellary/audit/comms.jsonl')
  })

  it('honours XDG_STATE_HOME', () => {
    expect(resolveAuditFile({ XDG_STATE_HOME: '/var/state' }, '/home/op')).toBe(
      '/var/state/cellary/audit/comms.jsonl',
    )
  })

  it('lets CELLARY_AUDIT_DIR override the XDG-derived directory', () => {
    const file = resolveAuditFile(
      { XDG_STATE_HOME: '/var/state', CELLARY_AUDIT_DIR: '/srv/audit' },
      '/home/op',
    )
    expect(file).toBe('/srv/audit/comms.jsonl')
  })
})
