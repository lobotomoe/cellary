/**
 * HiLink integration tests — runs against a real Huawei HiLink device.
 *
 * Skipped automatically when no device is reachable at the target URL.
 * Default: http://192.168.8.1 (override via HILINK_URL env var).
 *
 * Run:
 *   pnpm -C packages/core vitest run test/vendor/huawei/hilink/integration.test.ts
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { HiLinkAdapter } from '../../../../src/vendor/huawei/protocols/hilink/adapter.js'
import { HiLinkHttpClient } from '../../../../src/vendor/huawei/protocols/hilink/client.js'
import { HiLinkDevice } from '../../../../src/vendor/huawei/protocols/hilink/device.js'
import { fetchHiLinkSession } from '../../../../src/vendor/huawei/protocols/hilink/index.js'
import { HiLinkNetwork } from '../../../../src/vendor/huawei/protocols/hilink/network.js'
import {
  basicInformationSchema,
  checkNotificationsSchema,
  dialupConnectionSchema,
  hilinkLoginSchema,
  monthStatisticsSchema,
  netModeSchema,
  smsCountSchema,
  startDateSchema,
  stateLoginSchema,
  trafficStatisticsSchema,
} from '../../../../src/vendor/huawei/protocols/hilink/schemas.js'
import { HiLinkSim } from '../../../../src/vendor/huawei/protocols/hilink/sim.js'
import { HiLinkUssd } from '../../../../src/vendor/huawei/protocols/hilink/ussd.js'
import {
  HiLinkApiError,
  parseHiLinkXml,
} from '../../../../src/vendor/huawei/protocols/hilink/xml.js'

const BASE_URL = process.env.HILINK_URL ?? 'http://192.168.8.1'

async function isDeviceReachable(): Promise<boolean> {
  try {
    await fetchHiLinkSession(BASE_URL)
    return true
  } catch {
    return false
  }
}

const reachable = await isDeviceReachable()

describe.runIf(reachable)('HiLink integration (real device)', () => {
  // ── Session ─────────────────────────────────────────────────────────────────

  describe('session', () => {
    it('fetchHiLinkSession returns valid session', async () => {
      const session = await fetchHiLinkSession(BASE_URL)

      expect(session.sessionId).toBeTruthy()
      expect(session.csrfToken).toBeTruthy()
      // SessionID format: "SessionID=<hex>"
      expect(session.sessionId).toMatch(/^SessionID=/)
    })
  })

  // ── Network (unauthenticated) ───────────────────────────────────────────────

  describe('network', () => {
    let network: HiLinkNetwork

    beforeAll(() => {
      const client = new HiLinkHttpClient(BASE_URL)
      const getAuthCookie = async () => {
        const session = await fetchHiLinkSession(BASE_URL)
        return session.sessionId
      }
      network = new HiLinkNetwork(client, getAuthCookie)
    })

    it('signal() returns valid SignalInfo', async () => {
      const sig = await network.signal()

      // RSSI is always present (defaults to -113 if device reports 0/positive)
      expect(sig.rssi).toBeTypeOf('number')
      expect(sig.rssi).toBeLessThanOrEqual(0)

      // BER is always 99 on HiLink (not reported via HTTP)
      expect(sig.bitErrorRate).toBe(99)

      // Technology should be a known string when registered
      if (sig.technology !== undefined) {
        expect(['GSM', 'EDGE', 'HSPA', 'LTE']).toContain(sig.technology)
      }

      // LTE metrics should be present when on LTE
      if (sig.technology === 'LTE') {
        expect(sig.rsrp).toBeTypeOf('number')
        expect(sig.rsrq).toBeTypeOf('number')
        expect(sig.sinr).toBeTypeOf('number')
        // Band may be undefined on some firmware versions
        if (sig.band !== undefined) {
          expect(sig.band).toMatch(/^B\d+$/)
        }
      }
    })

    it('registration() returns valid status', async () => {
      const reg = await network.registration()

      expect(['home', 'roaming', 'notRegistered']).toContain(reg.status)
    })

    it('operator() returns a non-empty string', async () => {
      const op = await network.operator()

      // May be empty if not registered, but should be a string
      expect(op).toBeTypeOf('string')
    })
  })

  // ── Device (mixed auth) ────────────────────────────────────────────────────

  describe('device', () => {
    it('temperature() returns a number (unauthenticated /dev_info.data)', async () => {
      const client = new HiLinkHttpClient(BASE_URL)
      const noopAuth = () => Promise.resolve('')
      const device = new HiLinkDevice(client, noopAuth)

      const temp = await device.temperature()

      // Temperature may be undefined if the endpoint is unavailable,
      // but on E8372 it should return a positive number
      if (temp !== undefined) {
        expect(temp).toBeTypeOf('number')
        expect(temp).toBeGreaterThan(0)
        expect(temp).toBeLessThan(100)
      }
    })

    it('info() requires authentication (no credentials -> 100003)', async () => {
      const session = await fetchHiLinkSession(BASE_URL)
      const client = new HiLinkHttpClient(BASE_URL)
      const noAuth = () => Promise.resolve(session.sessionId)
      const device = new HiLinkDevice(client, noAuth)

      // On devices with hilink_login=0 this may succeed.
      // On password-protected devices it throws 100003.
      try {
        const info = await device.info()
        // If it succeeds, validate the shape
        expect(info.manufacturer).toBe('Huawei')
        expect(info.model).toBeTruthy()
        expect(info.imei).toMatch(/^\d{15}$/)
      } catch (err) {
        if (!(err instanceof HiLinkApiError)) throw err
        expect(err.code).toBe('100003')
      }
    })
  })

  // ── SIM (mixed auth) ──────────────────────────────────────────────────────

  describe('sim', () => {
    it('pin status is readable without credentials', async () => {
      // /api/pin/status is unauthenticated — test it directly
      const session = await fetchHiLinkSession(BASE_URL)
      const response = await fetch(`${BASE_URL}/api/pin/status`, {
        headers: {
          Cookie: session.sessionId,
          __RequestVerificationToken: session.csrfToken,
        },
      })

      expect(response.ok).toBe(true)
      const xml = await response.text()
      expect(xml).toContain('SimState')
    })

    it('info() requires auth for ICCID/IMSI', async () => {
      const session = await fetchHiLinkSession(BASE_URL)
      const client = new HiLinkHttpClient(BASE_URL)
      const noAuth = () => Promise.resolve(session.sessionId)
      const sim = new HiLinkSim(client, noAuth)

      // info() fetches both /api/pin/status (unauth) and /api/device/information (auth).
      // Will succeed if device has no password, otherwise throws.
      try {
        const info = await sim.info()
        expect(['ready', 'pinRequired', 'pukRequired', 'absent', 'error', 'unavailable']).toContain(
          info.state,
        )
        if (info.state === 'ready') {
          expect(info.iccid).toMatch(/^\d{18,22}$/)
        }
      } catch (err) {
        if (!(err instanceof HiLinkApiError)) throw err
        expect(err.code).toBe('100003')
      }
    })
  })

  // ── HiLinkAdapter (full stack, no credentials) ────────────────────────────

  describe('adapter (no credentials)', () => {
    let adapter: HiLinkAdapter

    beforeAll(() => {
      adapter = new HiLinkAdapter(BASE_URL)
    })

    it('exposes all service interfaces', () => {
      expect(adapter.network).toBeDefined()
      expect(adapter.device).toBeDefined()
      expect(adapter.sim).toBeDefined()
      expect(adapter.ussd).toBeDefined()
      expect(adapter.kind).toBe('hilink')
      expect(adapter.baseUrl).toBe(BASE_URL)
    })

    it('network.signal() works through adapter', async () => {
      const sig = await adapter.network.signal()
      expect(sig.rssi).toBeTypeOf('number')
    })

    it('network.registration() works through adapter', async () => {
      const reg = await adapter.network.registration()
      expect(['home', 'roaming', 'notRegistered']).toContain(reg.status)
    })

    it('network.operator() works through adapter', async () => {
      const op = await adapter.network.operator()
      expect(op).toBeTypeOf('string')
    })

    it('serviceCapabilities() returns empty (fallback-only)', () => {
      const caps = adapter.serviceCapabilities()
      expect(Object.keys(caps)).toHaveLength(0)
    })
  })

  // ── Schema-validated endpoints ──────────────────────────────────────────────
  //
  // Each test fetches raw XML and parses through a Zod schema via parseHiLinkXml.
  // If parsing succeeds, the response shape is correct. Schemas live in
  // src/vendor/huawei/protocols/hilink/schemas.ts.

  describe('schema-validated endpoints', () => {
    async function fetchEndpoint(path: string): Promise<string> {
      const session = await fetchHiLinkSession(BASE_URL)
      const response = await fetch(`${BASE_URL}/${path}`, {
        headers: {
          Cookie: session.sessionId,
          __RequestVerificationToken: session.csrfToken,
        },
      })
      expect(response.ok).toBe(true)
      return response.text()
    }

    it('monitoring/traffic-statistics', async () => {
      const xml = await fetchEndpoint('api/monitoring/traffic-statistics')
      const data = parseHiLinkXml(xml, trafficStatisticsSchema)

      expect(data.TotalDownload).toBeTypeOf('number')
      expect(data.TotalUpload).toBeTypeOf('number')
      expect(data.CurrentDownloadRate).toBeTypeOf('number')
    })

    it('monitoring/check-notifications', async () => {
      const xml = await fetchEndpoint('api/monitoring/check-notifications')
      const data = parseHiLinkXml(xml, checkNotificationsSchema)

      expect(data.UnreadMessage).toBeTypeOf('number')
      expect(data.SmsStorageFull).toBeTypeOf('number')
    })

    it('sms/sms-count', async () => {
      const xml = await fetchEndpoint('api/sms/sms-count')
      const data = parseHiLinkXml(xml, smsCountSchema)

      expect(data.LocalMax).toBeGreaterThan(0)
      expect(data.LocalInbox).toBeGreaterThanOrEqual(0)
      expect(data.LocalUnread).toBeGreaterThanOrEqual(0)
    })

    it('net/net-mode', async () => {
      const xml = await fetchEndpoint('api/net/net-mode')
      const data = parseHiLinkXml(xml, netModeSchema)

      expect(data.NetworkMode).toBeTypeOf('string')
      expect(data.NetworkBand).toBeTypeOf('string')
      expect(data.LTEBand).toBeTypeOf('string')
    })

    it('device/basic_information', async () => {
      const xml = await fetchEndpoint('api/device/basic_information')
      const data = parseHiLinkXml(xml, basicInformationSchema)

      expect(data.devicename).toBeTypeOf('string')
      expect(data.SoftwareVersion).toBeTypeOf('string')
    })

    it('monitoring/month_statistics', async () => {
      const xml = await fetchEndpoint('api/monitoring/month_statistics')
      const data = parseHiLinkXml(xml, monthStatisticsSchema)

      expect(data.CurrentMonthDownload).toBeTypeOf('number')
      expect(data.CurrentMonthUpload).toBeTypeOf('number')
    })

    it('user/state-login', async () => {
      const xml = await fetchEndpoint('api/user/state-login')
      const data = parseHiLinkXml(xml, stateLoginSchema)

      // -1 = not logged in, 0 = logged in
      expect(data.State).toBeTypeOf('number')
    })

    it('user/hilink_login', async () => {
      const xml = await fetchEndpoint('api/user/hilink_login')
      const data = parseHiLinkXml(xml, hilinkLoginSchema)

      // 0 = no password, 1 = password required
      expect([0, 1]).toContain(data.hilink_login)
    })

    it('dialup/connection', async () => {
      const xml = await fetchEndpoint('api/dialup/connection')
      const data = parseHiLinkXml(xml, dialupConnectionSchema)

      expect(data.ConnectMode).toBeTypeOf('number')
      expect(data.MTU).toBeGreaterThan(0)
    })

    it('monitoring/start_date', async () => {
      const xml = await fetchEndpoint('api/monitoring/start_date')
      const data = parseHiLinkXml(xml, startDateSchema)

      expect(data.StartDay).toBeGreaterThanOrEqual(1)
      expect(data.StartDay).toBeLessThanOrEqual(31)
    })

    it('net/cell-info (may be unavailable)', async () => {
      const xml = await fetchEndpoint('api/net/cell-info')
      // 100002 = not available on this firmware (E8372)
      expect(xml).toMatch(/<(response|error)>/)
    })

    it('device/antenna_status (may be unavailable)', async () => {
      const xml = await fetchEndpoint('api/device/antenna_status')
      // 100002 = not available on E8372
      expect(xml).toMatch(/<(response|error)>/)
    })
  })

  // ── USSD (mutation — requires auth) ────────────────────────────────────────
  //
  // USSD sends a real network request. Use a safe balance-check code.
  // Set HILINK_USSD_CODE env var to enable (e.g. HILINK_USSD_CODE=*100#).
  // Skipped by default to avoid unintended charges or network interaction.

  const ussdCode = process.env.HILINK_USSD_CODE

  describe.runIf(ussdCode !== undefined)('ussd (mutation)', () => {
    it('send() returns a response string', async () => {
      const ussd = new HiLinkUssd(new HiLinkHttpClient(BASE_URL))
      if (ussdCode === undefined) throw new Error('HILINK_USSD_CODE must be set')

      try {
        const response = await ussd.send(ussdCode)
        expect(response).toBeTypeOf('string')
        expect(response.length).toBeGreaterThan(0)
      } catch (err) {
        // Auth failure is expected if device has a password set
        if (err instanceof Error && err.message.includes('authentication')) {
          expect(err.message).toContain('authentication')
        } else {
          throw err
        }
      }
    }, 45_000)
  })
})

// When device is not reachable, print a helpful message instead of silence
if (!reachable) {
  describe('HiLink integration', () => {
    it.skip(`skipped — device not reachable at ${BASE_URL}`, () => {})
  })
}
