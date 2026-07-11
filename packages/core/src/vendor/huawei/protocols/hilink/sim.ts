import { z } from 'zod'

import { NotSupportedError } from '../../../../errors.js'
import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Sim } from '../../../../protocols/adapter.js'
import { normalizeIccid } from '../../../../protocols/services/sim.js'
import type { SimInfo } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { parseHiLinkXml } from './xml.js'

// ── HiLink SIM state codes from /api/pin/status ─────────────────────────────
// Tested on E8372H-153 fw 21.328.03.00.00

const SIM_STATE_ABSENT = 256
const SIM_STATE_READY = 257
const SIM_STATE_PIN_REQUIRED = 258
const SIM_STATE_PUK_REQUIRED = 259

function mapSimState(state: number | undefined): SimInfo['state'] {
  switch (state) {
    case SIM_STATE_READY:
      return 'ready'
    case SIM_STATE_PIN_REQUIRED:
      return 'pinRequired'
    case SIM_STATE_PUK_REQUIRED:
      return 'pukRequired'
    case SIM_STATE_ABSENT:
      return 'absent'
    default:
      return 'error'
  }
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const pinStatusSchema = z.object({
  SimState: z.number().optional(),
  SimPinTimes: z.number().optional(),
  SimPukTimes: z.number().optional(),
})

const deviceInformationSchema = z.object({
  Iccid: z.union([z.string(), z.number()]).optional(),
  Imsi: z.union([z.string(), z.number()]).optional(),
  Msisdn: z.union([z.string(), z.number()]).optional(),
})

/**
 * SIM service implementation for Huawei HiLink HTTP API.
 *
 * Uses /api/pin/status for SIM state and
 * /api/device/information for ICCID and IMSI. Both require authentication.
 *
 * Authentication is owned by HiLinkAdapter — this service receives a
 * getAuthCookie function that returns a cached session cookie.
 *
 * PIN entry requires an authenticated session with RSA-encrypted body —
 * not implemented yet. Throws on enterPin() calls.
 */
export class HiLinkSim implements Sim {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    private readonly getAuthCookie: () => Promise<string>,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async info(): Promise<SimInfo> {
    const cookie = await this.getAuthCookie()
    this._log.debug('GET', { path: 'api/pin/status, api/device/information' })
    const [pinXml, devXml] = await Promise.all([
      this.client.getAuth('api/pin/status', cookie),
      this.client.getAuth('api/device/information', cookie),
    ])

    const pin = parseHiLinkXml(pinXml, pinStatusSchema)
    const dev = parseHiLinkXml(devXml, deviceInformationSchema)

    return {
      iccid: dev.Iccid !== undefined ? normalizeIccid(String(dev.Iccid)) : undefined,
      imsi: dev.Imsi !== undefined ? String(dev.Imsi) : undefined,
      state: mapSimState(pin.SimState),
    }
  }

  async iccid(): Promise<string> {
    const cookie = await this.getAuthCookie()
    this._log.debug('GET', { path: 'api/device/information' })
    const xml = await this.client.getAuth('api/device/information', cookie)
    const data = parseHiLinkXml(xml, deviceInformationSchema)
    if (data.Iccid === undefined) {
      throw new Error('ICCID not available from HiLink API')
    }
    return normalizeIccid(String(data.Iccid))
  }

  async imsi(): Promise<string> {
    const cookie = await this.getAuthCookie()
    this._log.debug('GET', { path: 'api/device/information' })
    const xml = await this.client.getAuth('api/device/information', cookie)
    const data = parseHiLinkXml(xml, deviceInformationSchema)
    if (data.Imsi === undefined) {
      throw new Error('IMSI not available from HiLink API')
    }
    return String(data.Imsi)
  }

  async enterPin(_pin: string): Promise<void> {
    // HiLink PIN entry uses RSA-encrypted body — not yet implemented
    throw new NotSupportedError('enterPin (HiLink RSA not implemented)')
  }
}
