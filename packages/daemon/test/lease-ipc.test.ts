import { existsSync, unlinkSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient, DaemonRpcError } from '../src/ipc/client.js'
import { claimSchema, deviceIdSchema, RPC_ERRORS } from '../src/ipc/protocol.js'
import { IpcServer } from '../src/ipc/server.js'
import { LeaseRegistry } from '../src/lease-registry.js'

/**
 * End-to-end lease behavior over a real Unix socket: real IpcServer, real
 * DaemonClient(s), real LeaseRegistry, real error-code mapping. The onRequest
 * dispatch mirrors the daemon's (main.ts) -- claim/release and service calls
 * all enforce through one LeaseRegistry, and client disconnect auto-releases.
 * This covers what the LeaseRegistry unit tests can't: the wire protocol,
 * DeviceLeasedError -> DEVICE_LEASED code mapping, and client-side surfacing.
 */

const KNOWN_DEVICE = 'dev-1'
const FAKE_ICCID = '8900000000000000000'

let socketCounter = 0

describe('device lease over IPC', () => {
  let socketPath: string
  let server: IpcServer
  let leases: LeaseRegistry
  const clients: DaemonClient[] = []

  beforeEach(async () => {
    socketCounter += 1
    // Short path: a scratchpad-length path would blow the ~104-char Unix
    // socket limit. Ephemeral, removed in afterEach.
    socketPath = `/tmp/cellary-lease-${process.pid}-${socketCounter}.sock`
    leases = new LeaseRegistry()

    server = new IpcServer({
      socketPath,
      onRequest: async (method, params, clientId) => {
        if (method === 'devices.claim') {
          const { deviceId, ttlMs } = claimSchema.parse(params)
          if (deviceId !== KNOWN_DEVICE) throw new Error(`Device ${deviceId} not found`)
          return leases.claim(deviceId, clientId, ttlMs)
        }
        if (method === 'devices.release') {
          const { deviceId } = deviceIdSchema.parse(params)
          leases.release(deviceId, clientId)
          return null
        }
        if (method === 'sim.iccid') {
          const { deviceId } = deviceIdSchema.parse(params)
          leases.assertHolder(deviceId, clientId) // the getModemFor enforcement point
          return FAKE_ICCID
        }
        throw new Error(`Unknown method: ${method}`)
      },
      onClientDisconnected: (clientId) => {
        leases.releaseAllForClient(clientId)
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

  it('grants a claim to the first client and blocks the second', async () => {
    const a = await connectClient()
    const b = await connectClient()

    await expect(a.claim(KNOWN_DEVICE)).resolves.toBeUndefined()
    await expect(b.claim(KNOWN_DEVICE)).rejects.toThrow(/in use by another client/)
  })

  it('surfaces DeviceLeasedError with the DEVICE_LEASED code', async () => {
    const a = await connectClient()
    const b = await connectClient()
    await a.claim(KNOWN_DEVICE)

    const err = await b.claim(KNOWN_DEVICE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DaemonRpcError)
    if (err instanceof DaemonRpcError) {
      expect(err.code).toBe(RPC_ERRORS.DEVICE_LEASED)
    }
  })

  it('rejects a non-holder service call but allows the holder', async () => {
    const a = await connectClient()
    const b = await connectClient()
    await a.claim(KNOWN_DEVICE)

    await expect(b.serviceCall('sim.iccid', KNOWN_DEVICE)).rejects.toThrow(
      /in use by another client/,
    )
    await expect(a.serviceCall('sim.iccid', KNOWN_DEVICE)).resolves.toBe(FAKE_ICCID)
  })

  it('lets another client claim after the holder releases', async () => {
    const a = await connectClient()
    const b = await connectClient()
    await a.claim(KNOWN_DEVICE)
    await a.release(KNOWN_DEVICE)

    await expect(b.claim(KNOWN_DEVICE)).resolves.toBeUndefined()
  })

  it('auto-releases a lease when the holder disconnects', async () => {
    const a = await connectClient()
    await a.claim(KNOWN_DEVICE)

    a.disconnect()
    // Let the server process the socket close (onClientDisconnected).
    await new Promise((resolve) => setTimeout(resolve, 50))

    const c = await connectClient()
    await expect(c.claim(KNOWN_DEVICE)).resolves.toBeUndefined()
  })
})
