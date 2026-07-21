import { beforeEach, describe, expect, it } from 'vitest'

import type { AuditRecord, AuditSink } from '../../../src/audit.js'
import { AdbShell, type CommandMask } from '../../../src/protocols/adb/shell.js'
import type { AdbConnectionLike } from '../../../src/protocols/adb/wire.js'

/** A stub connection that records the raw command it received and replies with `response`. */
function fakeConn(response: string, sent: string[]): AdbConnectionLike {
  return {
    openShell: async (command: string) => {
      sent.push(command)
      return response
    },
    openStream: () => Promise.reject(new Error('openStream not used in these tests')),
    onDisconnect: () => {},
    close: async () => {},
    isOpen: true,
  }
}

// A generic secret-masking function. ADB is protocol-agnostic, so its tests stay
// free of any AT knowledge -- the caller decides what a secret looks like.
const maskSecret: CommandMask = (command) => command.replace(/secret-\w+/g, '[REDACTED]')

describe('AdbShell audit', () => {
  let records: AuditRecord[]
  let sink: AuditSink

  beforeEach(() => {
    records = []
    sink = { record: (r) => records.push(r) }
  })

  it('applies the injected mask to tx and rx, but sends the raw command', async () => {
    const sent: string[] = []
    const shell = new AdbShell(
      fakeConn('ok secret-token99 done', sent),
      undefined,
      sink,
      maskSecret,
    )

    await shell.exec('login secret-abc123')

    // The device must receive the real command -- masking is only for logs/audit.
    expect(sent).toEqual(['login secret-abc123'])

    const tx = records.find((r) => r.direction === 'tx')
    const rx = records.find((r) => r.direction === 'rx')
    expect(tx?.protocol).toBe('adb')
    expect(tx?.text).toBe('login [REDACTED]')
    expect(tx?.text).not.toContain('secret-abc123')
    expect(rx?.protocol).toBe('adb')
    expect(rx?.text).toBe('ok [REDACTED] done')
  })

  it('records raw traffic when no mask is injected (ADB is agnostic by default)', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('secret-xyz', sent), undefined, sink)

    await shell.exec('echo secret-abc')

    expect(records.find((r) => r.direction === 'tx')?.text).toBe('echo secret-abc')
    expect(records.find((r) => r.direction === 'rx')?.text).toBe('secret-xyz')
  })

  it('audits execWithStatus with the masked, parsed stdout, not the exit-code wrapper', async () => {
    const sent: string[] = []
    const conn = fakeConn('secret-out\n___ADB_EXIT___0', sent)
    const shell = new AdbShell(conn, undefined, sink, maskSecret)

    const result = await shell.execWithStatus('run secret-key')

    // The wrapped command (with the delimiter) is what reaches the device.
    expect(sent[0]).toContain('___ADB_EXIT___')
    expect(result.exitCode).toBe(0)

    const tx = records.find((r) => r.direction === 'tx')
    const rx = records.find((r) => r.direction === 'rx')
    expect(tx?.text).toBe('run [REDACTED]')
    expect(rx?.text).toBe('[REDACTED]')
  })

  it('works without a sink (no-op) and never throws', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('OK', sent))
    await expect(shell.exec('anything')).resolves.toMatchObject({ stdout: 'OK' })
    expect(sent).toEqual(['anything'])
  })
})
