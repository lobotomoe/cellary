import { z } from 'zod'

// ── GetSystemInfo ───────────────────────────────────────────────────────────

/** Trim trailing whitespace — JRD firmware appends \n to some string values */
const trimmed = z.string().transform((s) => s.trim())

export const systemInfoSchema = z.object({
  SwVersion: trimmed,
  HwVersion: trimmed,
  WebUiVersion: trimmed.optional(),
  DeviceName: trimmed,
  IMEI: trimmed,
  ICCID: trimmed.optional(),
  MacAddress: trimmed.optional(),
})

// ── GetNetworkInfo ──────────────────────────────────────────────────────────

export const networkInfoSchema = z.object({
  PLMN: z.string().optional(),
  NetworkType: z.number(),
  NetworkName: z.string().optional(),
  SignalStrength: z.number(),
  RSSI: z.string().optional(),
  RSRP: z.string().optional(),
  RSRQ: z.string().optional(),
  SINR: z.string().optional(),
  Band: z.number().optional(),
  Roaming: z.number().optional(),
  LTE_state: z.number().optional(),
})

/**
 * JRD NetworkType codes (from sdk.js).
 * Maps to radio access technology names.
 */
export const JRD_NETWORK_TYPE: Record<number, string> = {
  0: 'No service',
  1: 'GSM',
  2: 'GPRS',
  3: 'EDGE',
  4: 'WCDMA',
  5: 'HSDPA',
  6: 'HSUPA',
  7: 'HSPA',
  8: 'TD-SCDMA',
  9: 'HSPA+',
  10: 'EVDO Rev.0',
  11: 'EVDO Rev.A',
  12: 'EVDO Rev.B',
  13: '1xRTT',
  14: 'UMB',
  15: '1xEVDV',
  16: '3xRTT',
  17: 'HSPA+ 64QAM',
  18: 'HSPA+ MIMO',
  19: 'LTE',
  41: 'UMTS',
  46: 'CDMA',
  101: 'LTE+',
}

// ── GetSimStatus ────────────────────────────────────────────────────────────

export const simStatusSchema = z.object({
  SIMState: z.number(),
  PinState: z.number().optional(),
  PinRemainingTimes: z.number().optional(),
  PukRemainingTimes: z.number().optional(),
  SIMLockState: z.number().optional(),
  SIMLockRemainingTimes: z.number().optional(),
})

/**
 * JRD SIM state codes (from sdk.js).
 *
 * 0 = UNKNOWN, 1 = DETECTED (error), 2 = PIN required, 3 = PUK required,
 * 4 = PERSON_CHECK_REQ (network lock), 5 = PIN permanently blocked,
 * 6 = ILLEGAL, 7 = READY, 11 = INITING
 */
export const JRD_SIM_STATE = {
  UNKNOWN: 0,
  DETECTED: 1,
  PIN_REQUIRED: 2,
  PUK_REQUIRED: 3,
  PERSON_CHECK: 4,
  PIN_BLOCKED: 5,
  ILLEGAL: 6,
  READY: 7,
  INITING: 11,
} as const

// ── GetConnectionState ──────────────────────────────────────────────────────

export const connectionStateSchema = z.object({
  ConnectionStatus: z.number(),
  IPv4Adrress: z.string().optional(),
  Speed_Dl: z.number().optional(),
  Speed_Ul: z.number().optional(),
  ConnectionTime: z.number().optional(),
  UlBytes: z.number().optional(),
  DlBytes: z.number().optional(),
})

// ── GetSystemStatus ─────────────────────────────────────────────────────────

export const systemStatusSchema = z.object({
  chg_state: z.number().optional(),
  bat_cap: z.number().optional(),
  bat_level: z.number().optional(),
  NetworkType: z.number().optional(),
  NetworkName: z.string().optional(),
  Roaming: z.number().optional(),
  SignalStrength: z.number().optional(),
  ConnectionStatus: z.number().optional(),
  WlanState: z.number().optional(),
  curr_num: z.number().optional(),
  TotalConnNum: z.number().optional(),
})

// ── GetSMSStorageState ──────────────────────────────────────────────────────

export const smsStorageSchema = z.object({
  UnreadSMSCount: z.number(),
  SMSMaxCount: z.number(),
  SMSCount: z.number(),
})
