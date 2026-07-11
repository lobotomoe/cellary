import { z } from 'zod'

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Device } from '../../../../protocols/adapter.js'
import type { DeviceInfo } from '../../../../types.js'
import type { HiLinkHttpClient } from './client.js'
import { parseHiLinkXml, parseXmlRaw } from './xml.js'

// ── Zod schemas ──────────────────────────────────────────────────────────────

// /dev_info.data uses <config> wrapper, not <response>.
// parseHiLinkXml falls through to schema.parse(parsed) when no <response> is found.
const devInfoConfigSchema = z.object({
  config: z.object({
    chiptemp: z.number().optional(),
  }),
})

// ── Zod schema for /api/device/information ──────────────────────────────────

const deviceInformationSchema = z.object({
  DeviceName: z.string().optional(),
  SerialNumber: z.string().optional(),
  Imei: z.union([z.string(), z.number()]).optional(),
  HardwareVersion: z.string().optional(),
  SoftwareVersion: z.string().optional(),
  Classify: z.string().optional(),
})

/**
 * Device service implementation for Huawei HiLink HTTP API.
 *
 * Uses /api/device/information (authenticated) for model, IMEI, and firmware info.
 * Temperature comes from /dev_info.data (unauthenticated) — an undocumented
 * endpoint polled by the HiLink web UI that returns chip temp in tenths of a
 * degree Celsius.
 *
 * Authentication is owned by HiLinkAdapter — this service receives a
 * getAuthCookie function that returns a cached session cookie.
 */
export class HiLinkDevice implements Device {
  private readonly _log: Logger

  constructor(
    private readonly client: HiLinkHttpClient,
    private readonly getAuthCookie: () => Promise<string>,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async info(): Promise<DeviceInfo> {
    const cookie = await this.getAuthCookie()
    this._log.debug('GET', { path: 'api/device/information' })
    const xml = await this.client.getAuth('api/device/information', cookie)
    const data = parseHiLinkXml(xml, deviceInformationSchema)

    if (data.Imei === undefined) {
      throw new Error('IMEI not available from HiLink API')
    }

    return {
      manufacturer: 'Huawei',
      model: data.DeviceName,
      revision: data.SoftwareVersion,
      imei: String(data.Imei),
      hardwareVersion: data.HardwareVersion,
    }
  }

  async imei(): Promise<string> {
    const cookie = await this.getAuthCookie()
    this._log.debug('GET', { path: 'api/device/information' })
    const xml = await this.client.getAuth('api/device/information', cookie)
    const data = parseHiLinkXml(xml, deviceInformationSchema)
    if (data.Imei === undefined) {
      throw new Error('IMEI not available from HiLink API')
    }
    return String(data.Imei)
  }

  /**
   * Read the chip temperature in degrees Celsius from /dev_info.data.
   *
   * This undocumented endpoint (polled by the HiLink web UI) returns
   * temperature in tenths of a degree: 376 = 37.6 C. Unauthenticated.
   */
  async temperature(): Promise<number | undefined> {
    try {
      this._log.debug('GET', { path: 'dev_info.data' })
      const xml = await this.client.get('dev_info.data')
      // dev_info.data uses <config> wrapper — parseHiLinkXml sees no <response>
      // and falls through to schema.parse(parsed), so the schema must include <config>.
      const data = devInfoConfigSchema.parse(parseXmlRaw(xml))
      const raw = data.config.chiptemp
      if (raw === undefined || raw <= 0) return undefined
      // Convert from tenths of a degree: 376 -> 37.6
      return Math.round((raw / 10) * 10) / 10
    } catch (err: unknown) {
      // Best-effort: /dev_info.data is undocumented and absent on some firmware
      this._log.debug('temperature unavailable', {
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }
}
