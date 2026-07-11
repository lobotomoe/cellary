import { z } from 'zod'

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Network } from '../../../../protocols/adapter.js'
import type { AvailableNetwork, RegistrationInfo, SignalInfo } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { parseHiLinkXml } from './xml.js'

const BER_UNKNOWN = 99

// HiLink /api/device/signal <mode> values (Huawei vendor-specific)
// Tested on E8372H-153 fw 21.328.03.00.00
const HILINK_SIGNAL_MODE: Record<number, string> = {
  0: 'GSM',
  2: 'EDGE',
  5: 'HSPA',
  7: 'LTE',
}

// /api/monitoring/status ServiceStatus codes (radio registration, not data connection)
const SERVICE_STATUS_VALID = 2

// ── Zod schemas for HiLink XML responses ────────────────────────────────────

const signalResponseSchema = z.object({
  rssi: z.union([z.number(), z.string()]).optional(),
  rsrp: z.union([z.number(), z.string()]).optional(),
  rsrq: z.union([z.number(), z.string()]).optional(),
  sinr: z.union([z.number(), z.string()]).optional(),
  band: z.union([z.number(), z.string()]).optional(),
  mode: z.union([z.number(), z.string()]).optional(),
})

const monitoringStatusSchema = z.object({
  ServiceStatus: z.number().optional(),
  RoamingStatus: z.number().optional(),
})

const currentPlmnSchema = z.object({
  FullName: z.string().optional(),
})

// /api/net/plmn-list response (network scan)
// <State> values match 3GPP AT+COPS status codes
const PLMN_STATUS: Record<number, AvailableNetwork['status']> = {
  0: 'unknown',
  1: 'available',
  2: 'current',
  3: 'forbidden',
}

// <Rat> radio access technology codes (HiLink-specific)
const PLMN_RAT: Record<number, string> = {
  0: 'GSM',
  2: 'UMTS',
  7: 'LTE',
}

const plmnItemSchema = z.object({
  State: z.number().optional(),
  FullName: z.string().optional(),
  ShortName: z.string().optional(),
  Numeric: z.union([z.string(), z.number()]).optional(),
  Rat: z.number().optional(),
})

// fast-xml-parser returns a single object when there's one item, array when multiple
const plmnListSchema = z.object({
  Networks: z.object({
    Network: z
      .union([z.array(plmnItemSchema), plmnItemSchema])
      .transform((v) => (Array.isArray(v) ? v : [v])),
  }),
})

const SCAN_TIMEOUT_MS = 120_000

/**
 * Parse a dBm value from a HiLink XML field.
 * Fields may be number or string with units (e.g. "-67dBm", "-11.0dB").
 * 0 dBm or positive for RSSI is physically unrealistic for cellular — treat as unknown.
 * For RSRP/RSRQ/SINR, 0 may be valid, so we only filter NaN.
 */
function parseDbm(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const num = typeof value === 'string' ? Number(value.replace(/[^\d.-]/g, '')) : value
  if (Number.isNaN(num)) return undefined
  return num
}

/**
 * Network service implementation for Huawei HiLink HTTP API.
 *
 * All endpoints require a session cookie from /api/webserver/SesTokInfo
 * (no credentials needed, but the cookie must be present).
 * Provides richer signal data than AT+CSQ: includes RSRP, RSRQ, SINR, band info.
 */
export class HiLinkNetwork implements Network {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    private readonly getAuthCookie: () => Promise<string>,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async signal(): Promise<SignalInfo> {
    this._log.debug('GET', { path: 'api/device/signal' })
    const xml = await this.client.get('api/device/signal')
    const data = parseHiLinkXml(xml, signalResponseSchema)

    const rawRssi = parseDbm(data.rssi)
    // 0 dBm or positive is physically unrealistic for cellular — treat as unknown
    const rssi = rawRssi !== undefined && rawRssi < 0 ? rawRssi : undefined
    const rsrp = parseDbm(data.rsrp)
    const rsrq = parseDbm(data.rsrq)
    const sinr = parseDbm(data.sinr)
    const band = data.band !== undefined ? `B${data.band}` : undefined

    const modeNum = data.mode !== undefined ? Number(data.mode) : undefined
    const technology =
      modeNum !== undefined && !Number.isNaN(modeNum) ? HILINK_SIGNAL_MODE[modeNum] : undefined

    return {
      rssi,
      bitErrorRate: BER_UNKNOWN,
      technology,
      rsrp,
      rsrq,
      sinr,
      band,
    }
  }

  async registration(): Promise<RegistrationInfo> {
    this._log.debug('GET', { path: 'api/monitoring/status' })
    const xml = await this.client.get('api/monitoring/status')
    const data = parseHiLinkXml(xml, monitoringStatusSchema)

    if (data.ServiceStatus === SERVICE_STATUS_VALID) {
      return { status: data.RoamingStatus === 1 ? 'roaming' : 'home' }
    }

    return { status: 'notRegistered' }
  }

  async operator(): Promise<string | undefined> {
    this._log.debug('GET', { path: 'api/net/current-plmn' })
    const xml = await this.client.get('api/net/current-plmn')
    const data = parseHiLinkXml(xml, currentPlmnSchema)
    return data.FullName
  }

  async scan(): Promise<AvailableNetwork[]> {
    this._log.debug('GET', { path: 'api/net/plmn-list (scan, up to 120s)' })
    const cookie = await this.getAuthCookie()
    const xml = await this.client.getAuth('api/net/plmn-list', cookie, SCAN_TIMEOUT_MS)
    const data = parseHiLinkXml(xml, plmnListSchema)

    return data.Networks.Network.map((item) => ({
      status: item.State !== undefined ? (PLMN_STATUS[item.State] ?? 'unknown') : 'unknown',
      name: item.FullName,
      shortName: item.ShortName,
      numeric: item.Numeric !== undefined ? String(item.Numeric) : '',
      technology: item.Rat !== undefined ? PLMN_RAT[item.Rat] : undefined,
    }))
  }
}
