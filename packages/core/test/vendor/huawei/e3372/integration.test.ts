/**
 * E3372H integration tests -- runs against a real Huawei E3372H device.
 *
 * Requires the cellary daemon running with an E3372H connected.
 * Skipped automatically when no device is available.
 *
 * Works with or without SIM card inserted.
 *
 * Run:
 *   pnpm -C packages/core vitest run test/vendor/huawei/e3372/integration.test.ts
 */

import { connect, type Socket } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

// ── Minimal IPC client (avoids cross-package import) ─────────────────────────

const SOCKET_PATH = '/var/run/cellaryd.sock'
const REQUEST_TIMEOUT_MS = 10_000
const HUAWEI_VID = 0x12d1

const deviceInfoSchema = z.object({
  deviceId: z.string(),
  vendorId: z.number(),
  name: z.string(),
  stage: z.string(),
  modelName: z.string().optional(),
  discovery: z
    .object({
      mode: z.string(),
      productId: z.number(),
      busNumber: z.number().optional(),
      portNumbers: z.array(z.number()).optional(),
    })
    .optional(),
})

type DeviceInfo = z.infer<typeof deviceInfoSchema>

/** Lightweight JSON-RPC client for integration tests. */
class TestIpcClient {
  private socket: Socket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = ''

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('Connection timeout'))
      }, 2_000)

      const sock = connect(SOCKET_PATH, () => {
        clearTimeout(timer)
        this.socket = sock
        this.setupHandlers(sock)
        resolve()
      })
      sock.on('error', (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private setupHandlers(sock: Socket): void {
    sock.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8')
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line.length > 0) this.handleLine(line)
        idx = this.buffer.indexOf('\n')
      }
    })
  }

  private handleLine(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id === undefined) return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error !== undefined) {
      p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`))
    } else {
      p.resolve(msg.result)
    }
  }

  call(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error('Not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      const req = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })
      this.socket?.write(`${req}\n`)
    })
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
  }
}

// ── Device probe ─────────────────────────────────────────────────────────────

async function probeE3372(): Promise<{ deviceId: string; device: DeviceInfo } | undefined> {
  const client = new TestIpcClient()
  try {
    await client.connect()
    const raw = await client.call('devices.list')
    client.disconnect()
    const devices = z.array(deviceInfoSchema).parse(raw)
    const huawei = devices.find((d) => d.vendorId === HUAWEI_VID && d.modelName?.includes('E3372'))
    if (huawei === undefined) return undefined
    return { deviceId: huawei.deviceId, device: huawei }
  } catch {
    client.disconnect()
    return undefined
  }
}

const probeResult = await probeE3372()
const available = probeResult !== undefined

// ── Tests ────────────────────────────────────────────────────────────────────

describe.runIf(available)('E3372H integration (real device)', () => {
  let client: TestIpcClient
  let deviceId: string
  let device: DeviceInfo

  beforeAll(async () => {
    // probeResult is guaranteed defined by runIf(available)
    if (probeResult === undefined) throw new Error('unreachable')
    deviceId = probeResult.deviceId
    device = probeResult.device
    client = new TestIpcClient()
    await client.connect()
  })

  afterAll(() => {
    client.disconnect()
  })

  // ── Discovery & identification ───────────────────────────────────────────

  describe('discovery', () => {
    it('device is discovered with correct metadata', () => {
      expect(device.vendorId).toBe(HUAWEI_VID)
      expect(device.modelName).toBe('Huawei E3372')
      expect(device.name).toBe('Huawei')
      expect(device.deviceId).toBeTruthy()
    })

    it('device has USB discovery info', () => {
      const disc = device.discovery
      expect(disc).toBeDefined()
      if (disc === undefined) return
      expect(disc.mode).toBe('modem-usb')
      expect(disc.productId).toBe(0x1506) // stick mode PID
      expect(disc.busNumber).toBeTypeOf('number')
      expect(disc.portNumbers).toBeInstanceOf(Array)
    })

    it('device reaches ready or degraded stage', () => {
      expect(['ready', 'degraded']).toContain(device.stage)
    })
  })

  // ── Device info (AT+CGMI, AT+CGMR, AT+CGSN) ────────────────────────────

  describe('device info', () => {
    it('reads device info (manufacturer, IMEI)', async () => {
      const raw = await client.call('device.info', { deviceId })
      const result = z
        .object({
          manufacturer: z.string(),
          imei: z.string(),
          revision: z.string().optional(),
        })
        .parse(raw)
      expect(result.manufacturer).toBeTruthy()
      expect(result.imei).toMatch(/^\d{15}$/)
    }, 15_000)

    it('reads IMEI directly', async () => {
      const result = await client.call('device.imei', { deviceId })
      expect(result).toMatch(/^\d{15}$/)
    }, 10_000)
  })

  // ── SIM detection ──────────────────────────────────────────────────────────

  describe('SIM', () => {
    it('reports SIM state without hanging', async () => {
      const start = Date.now()
      const raw = await client.call('sim.info', { deviceId })
      const result = z
        .object({
          state: z.string(),
          iccid: z.string().optional(),
          imsi: z.string().optional(),
          operator: z.string().optional(),
        })
        .parse(raw)
      const elapsed = Date.now() - start

      // Must not hang -- markAbsent() should make this instant when SIM is absent
      expect(elapsed).toBeLessThan(5_000)

      expect(['ready', 'absent', 'pinRequired', 'pukRequired', 'error', 'unavailable']).toContain(
        result.state,
      )

      if (result.state === 'ready') {
        expect(result.iccid).toBeTruthy()
      }

      if (result.state === 'absent') {
        expect(result.iccid).toBeUndefined()
      }
    }, 10_000)
  })

  // ── Network ────────────────────────────────────────────────────────────────

  describe('network', () => {
    it('reads signal strength', async () => {
      const raw = await client.call('network.signal', { deviceId })
      const result = z
        .object({
          rssi: z.number(),
          bitErrorRate: z.number(),
        })
        .parse(raw)
      expect(result.rssi).toBeTypeOf('number')
      expect(result.bitErrorRate).toBeTypeOf('number')
    }, 10_000)

    it('reads registration status', async () => {
      const raw = await client.call('network.registration', { deviceId })
      const result = z.object({ status: z.string() }).parse(raw)
      expect(result.status).toBeTruthy()
      expect([
        'registered',
        'notRegistered',
        'searching',
        'denied',
        'unknown',
        'roaming',
      ]).toContain(result.status)
    }, 10_000)
  })

  // ── Daemon status ──────────────────────────────────────────────────────────

  describe('daemon', () => {
    it('reports status', async () => {
      const raw = await client.call('daemon.status')
      const result = z
        .object({
          pid: z.number(),
          uptime: z.number(),
          deviceCount: z.number(),
          version: z.string(),
        })
        .parse(raw)
      expect(result.pid).toBeTypeOf('number')
      expect(result.uptime).toBeTypeOf('number')
      expect(result.deviceCount).toBeGreaterThanOrEqual(1)
      expect(result.version).toBeTruthy()
    })
  })
})
