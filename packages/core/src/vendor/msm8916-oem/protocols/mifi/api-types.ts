/**
 * Type definitions for the MiFi HTTP management API.
 *
 * All endpoints: POST http://192.168.100.1/ajax
 * Body: JSON with "funcNo" field selecting the operation.
 *
 * Some endpoints require authentication (login first with funcNo=1000).
 */
import { z } from 'zod'

// ── funcNo constants ────────────────────────────────────────────────────────

export const FUNC = {
  // ── Network & Status (no auth) ──────────────────────────────────────────
  /** Login — returns session token. Default: admin/admin. */
  login: 1000,
  /** Network status (signal, operator, technology) */
  networkStatus: 1001,
  /** SIM status (inserted, PIN state) */
  simStatus: 1005,
  /** Device info (IMEI, firmware version, manufacturer) */
  deviceInfo: 1029,
  /** Battery status (level, charging state) */
  batteryStatus: 1030,
  /** Data usage statistics */
  dataUsage: 1031,

  // ── SMS ─────────────────────────────────────────────────────────────────
  /** SMS inbox list */
  smsList: 1002,
  /** Send SMS (number + text) */
  smsSend: 1003,
  /** Delete SMS by index */
  smsDelete: 1004,

  // ── WiFi & Network Config ──────────────────────────────────────────────
  /** WiFi encryption (password, security type). Does NOT disable WiFi. */
  wifiEncryption: 1010,
  /** WiFi SSID settings */
  wifiSsid: 1011,
  /** WiFi advanced (channel, bandwidth) */
  wifiAdvanced: 1012,
  /** WiFi MAC filter */
  wifiMacFilter: 1013,
  /** DHCP settings */
  dhcpSettings: 1014,
  /** Connected WiFi clients list */
  wifiClients: 1015,

  // ── Cellular & APN ─────────────────────────────────────────────────────
  /** APN settings (read) */
  apnRead: 1006,
  /** APN settings (write) */
  apnWrite: 1007,
  /** Network mode preference (2G/3G/4G) */
  networkMode: 1008,
  /** Network band selection */
  bandSelection: 1009,

  // ── System & USB ───────────────────────────────────────────────────────
  /** PIN management (enter/change/enable/disable) */
  pinManagement: 1020,
  /** USB composition change (mode=1 -> DIAG+AT+MODEM+RNDIS) */
  usbComposition: 1022,
  /** Factory reset */
  factoryReset: 1025,
  /** Reboot device */
  reboot: 1026,
  /** Enable ADB — device reboots with new USB PID */
  enableAdb: 2001,
  /** Firmware update */
  firmwareUpdate: 2002,
  /** Language settings */
  language: 2003,
  /** Time zone settings */
  timezone: 2004,
} as const

// ── Request types ───────────────────────────────────────────────────────────

export interface MifiLoginRequest {
  readonly funcNo: typeof FUNC.login
  readonly username: string
  readonly password: string
}

export interface MifiUsbCompositionRequest {
  readonly funcNo: typeof FUNC.usbComposition
  /** 1 = enable DIAG+AT+MODEM alongside RNDIS */
  readonly mode: number
}

export interface MifiSmsSendRequest {
  readonly funcNo: typeof FUNC.smsSend
  readonly number: string
  readonly text: string
}

// ── Response envelope ────────────────────────────────────────────────────────

/** Build an envelope schema for a given payload type. */
export function mifiEnvelopeSchema<T extends z.ZodType>(payload: T) {
  return z.object({
    results: z.tuple([payload]),
    error_info: z.string(),
    flag: z.string(),
  })
}

/** Parsed envelope with untyped payload (for callRaw). */
export const mifiRawEnvelopeSchema = z.object({
  results: z.array(z.record(z.string(), z.unknown())).min(1),
  error_info: z.string(),
  flag: z.string(),
})

export type MifiRawEnvelope = z.infer<typeof mifiRawEnvelopeSchema>

// ── Response payloads (confirmed via live testing over RNDIS) ────────────────

export const mifiDeviceInfoSchema = z.object({
  manufacture: z.string(),
  dbm: z.string(),
  fwversion: z.string(),
  imei: z.string(),
})

export type MifiDeviceInfo = z.infer<typeof mifiDeviceInfoSchema>

export const mifiNetworkStatusSchema = z.object({
  oper: z.string(),
  netstatus: z.string(),
  netmode: z.string(),
  rssi: z.number(),
})

export type MifiNetworkStatus = z.infer<typeof mifiNetworkStatusSchema>
