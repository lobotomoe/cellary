import { existsSync, unlinkSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertMethodAllowed } from '../src/authz.js'
import { DaemonClient, DaemonRpcError } from '../src/ipc/client.js'
import { RPC_ERRORS } from '../src/ipc/protocol.js'
import { IpcServer } from '../src/ipc/server.js'

/**
 * End-to-end per-method authz over a real Unix socket: real IpcServer + client,
 * the real authz gate, and the real MethodForbiddenError -> METHOD_FORBIDDEN
 * code mapping in server.getErrorCode. `allowShell` is mutable so a single
 * server can exercise both the disabled and enabled policy.
 */

let socketCounter = 0

describe('per-method authz over IPC', () => {
  let socketPath: string
  let server: IpcServer
  let allowShell: boolean
  const clients: DaemonClient[] = []

  beforeEach(async () => {
    socketCounter += 1
    socketPath = `/tmp/cellary-authz-${process.pid}-${socketCounter}.sock`
    allowShell = false

    server = new IpcServer({
      socketPath,
      onRequest: async (method) => {
        assertMethodAllowed(method, { allowShell })
        if (method === 'system.shell') return 'shell-output'
        throw new Error(`Unknown method: ${method}`)
      },
    })
    await server.start()
  })

  afterEach(async () => {
    for (const c of clients) c.disconnect()
    clients.length = 0
    await server.stop()
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

  it('rejects system.shell by default with the METHOD_FORBIDDEN code', async () => {
    const client = await connectClient()

    const err = await client.call('system.shell', { command: 'id' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonRpcError)
    if (err instanceof DaemonRpcError) {
      expect(err.code).toBe(RPC_ERRORS.METHOD_FORBIDDEN)
      expect(err.message).toContain('CELLARY_ALLOW_SHELL')
    }
  })

  it('allows system.shell once shell access is enabled', async () => {
    allowShell = true
    const client = await connectClient()

    await expect(client.call('system.shell', { command: 'id' })).resolves.toBe('shell-output')
  })

  it('never gates a non-privileged method', async () => {
    const client = await connectClient()

    // devices.list is not privileged; it reaches the handler (which here is the
    // unknown-method branch), proving the authz gate let it through.
    const err = await client.call('devices.list').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonRpcError)
    if (err instanceof DaemonRpcError) {
      expect(err.code).not.toBe(RPC_ERRORS.METHOD_FORBIDDEN)
    }
  })
})
