import { beforeEach, describe, expect, it } from 'vitest'

import type { AuditRecord, AuditSink } from '../../../src/audit.js'
import { AdbShell } from '../../../src/protocols/adb/shell.js'
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

describe('AdbShell audit', () => {
  let records: AuditRecord[]
  let sink: AuditSink

  beforeEach(() => {
    records = []
    sink = { record: (r) => records.push(r) }
  })

  it('emits a masked tx and rx record for exec, but sends the raw command', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('+CPIN: READY\r\nOK\r\n', sent), undefined, sink)

    await shell.exec('AT+CPIN="1234"')

    // The device must receive the real command -- masking is only for logs/audit.
    expect(sent).toEqual(['AT+CPIN="1234"'])

    const tx = records.find((r) => r.direction === 'tx')
    const rx = records.find((r) => r.direction === 'rx')
    expect(tx?.protocol).toBe('adb')
    expect(tx?.text).toBe('AT+CPIN=[REDACTED]')
    expect(tx?.text).not.toContain('1234')
    expect(rx?.protocol).toBe('adb')
    expect(rx?.text).toBe('+CPIN: READY\r\nOK\r\n')
  })

  it('masks AT credentials echoed back in the response', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('AT+CPWD="ab","cd"\r\nOK', sent), undefined, sink)

    await shell.exec('cat /tmp/last_cmd')

    const rx = records.find((r) => r.direction === 'rx')
    expect(rx?.text).toContain('[REDACTED]')
    expect(rx?.text).not.toContain('"ab","cd"')
  })

  it('audits execWithStatus with the parsed stdout, not the exit-code wrapper', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('file-a\nfile-b\n___ADB_EXIT___0', sent), undefined, sink)

    const result = await shell.execWithStatus('ls')

    // The wrapped command (with the delimiter) is what reaches the device.
    expect(sent[0]).toContain('___ADB_EXIT___')
    expect(result.exitCode).toBe(0)

    const tx = records.find((r) => r.direction === 'tx')
    const rx = records.find((r) => r.direction === 'rx')
    expect(tx?.text).toBe('ls')
    expect(rx?.text).toBe('file-a\nfile-b')
  })

  it('works without a sink (no-op) and never throws', async () => {
    const sent: string[] = []
    const shell = new AdbShell(fakeConn('OK', sent))
    await expect(shell.exec('AT+CPIN="9999"')).resolves.toMatchObject({ stdout: 'OK' })
    expect(sent).toEqual(['AT+CPIN="9999"'])
  })
})
