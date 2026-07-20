import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditReader } from '../src/audit-reader.js'
import { FileAuditSink } from '../src/audit-sink.js'
import { DaemonClient } from '../src/ipc/client.js'
import { auditTailSchema } from '../src/ipc/protocol.js'
import { IpcServer } from '../src/ipc/server.js'

/**
 * End-to-end daemon.auditTail over a real Unix socket: real IpcServer, real
 * DaemonClient, real AuditReader over a real file, real superjson transport and
 * client-side schema validation. Covers what the AuditReader unit tests can't:
 * the wire protocol and that the reader's output satisfies auditLineSchema.
 */

let socketCounter = 0

describe('daemon.auditTail over IPC', () => {
  let socketPath: string
  let dir: string
  let server: IpcServer
  const clients: DaemonClient[] = []

  beforeEach(async () => {
    socketCounter += 1
    socketPath = `/tmp/cellary-audit-${process.pid}-${socketCounter}.sock`
    dir = mkdtempSync(join(tmpdir(), 'cellary-audit-ipc-'))
    const file = join(dir, 'comms.jsonl')

    const sink = new FileAuditSink(file)
    sink.append('dev-1', { timestamp: 1, protocol: 'at', direction: 'tx', text: 'AT+CSQ' })
    sink.append('dev-2', { timestamp: 2, protocol: 'at', direction: 'tx', text: 'AT+COPS?' })
    sink.append('dev-1', {
      timestamp: 3,
      protocol: 'at',
      direction: 'rx',
      text: '',
      outcome: 'timeout',
    })
    sink.close()

    const reader = new AuditReader(file)

    server = new IpcServer({
      socketPath,
      onRequest: async (method, params) => {
        if (method === 'daemon.auditTail') {
          const { limit, deviceId } = auditTailSchema.parse(params)
          return reader.tail({ limit, deviceId })
        }
        throw new Error(`Unknown method: ${method}`)
      },
    })
    await server.start()
  })

  afterEach(async () => {
    for (const c of clients) c.disconnect()
    clients.length = 0
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // server.stop() usually removes the socket already.
      }
    }
  })

  async function connectClient(): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath })
    await client.connect()
    clients.push(client)
    return client
  }

  it('returns all records validated against the schema, oldest-first', async () => {
    const client = await connectClient()
    const tail = await client.auditTail()

    expect(tail.map((r) => r.ts)).toEqual([1, 2, 3])
    expect(tail[2]).toMatchObject({ deviceId: 'dev-1', dir: 'rx', outcome: 'timeout' })
  })

  it('honors the deviceId filter over the wire', async () => {
    const client = await connectClient()
    const tail = await client.auditTail({ deviceId: 'dev-1' })

    expect(tail.map((r) => r.ts)).toEqual([1, 3])
    expect(tail.every((r) => r.deviceId === 'dev-1')).toBe(true)
  })

  it('honors the limit over the wire', async () => {
    const client = await connectClient()
    const tail = await client.auditTail({ limit: 1 })

    expect(tail.map((r) => r.ts)).toEqual([3])
  })
})
