/**
 * Zod schemas for HiLink API responses.
 *
 * Each schema maps 1:1 to an API endpoint. Field names match the XML element
 * names exactly (PascalCase / camelCase as the firmware returns them).
 *
 * Validated against E8372H-153 fw 21.328.03.00.00 via integration tests.
 * Not all fields may be present on every firmware version — optional where
 * observed to vary.
 */

import { z } from 'zod'

// ── Monitoring ──────────────────────────────────────────────────────────────

/** GET /api/monitoring/traffic-statistics */
export const trafficStatisticsSchema = z.object({
  CurrentConnectTime: z.number(),
  CurrentUpload: z.number(),
  CurrentDownload: z.number(),
  CurrentDownloadRate: z.number(),
  CurrentUploadRate: z.number(),
  TotalUpload: z.number(),
  TotalDownload: z.number(),
  TotalConnectTime: z.number(),
  showtraffic: z.number().optional(),
})

/** GET /api/monitoring/check-notifications */
export const checkNotificationsSchema = z.object({
  UnreadMessage: z.number(),
  SmsStorageFull: z.number(),
  OnlineUpdateStatus: z.number().optional(),
})

/** GET /api/monitoring/month_statistics */
export const monthStatisticsSchema = z.object({
  CurrentMonthDownload: z.number(),
  CurrentMonthUpload: z.number(),
  MonthDuration: z.number(),
  MonthLastClearTime: z.string().optional(),
})

/** GET /api/monitoring/start_date */
export const startDateSchema = z.object({
  StartDay: z.number(),
  DataLimit: z.string().optional(),
  DataLimitAwoke: z.number().optional(),
  MonthThreshold: z.number().optional(),
  SetMonthData: z.number().optional(),
  trafficmaxlimit: z.number().optional(),
})

// ── SMS ─────────────────────────────────────────────────────────────────────

/** GET /api/sms/sms-count */
export const smsCountSchema = z.object({
  LocalUnread: z.number(),
  LocalInbox: z.number(),
  LocalOutbox: z.number(),
  LocalDraft: z.number(),
  LocalDeleted: z.number(),
  SimUnread: z.number(),
  SimInbox: z.number(),
  SimOutbox: z.number(),
  SimDraft: z.number(),
  LocalMax: z.number(),
  SimMax: z.number(),
  SimUsed: z.number(),
  NewMsg: z.number(),
})

// ── Network ─────────────────────────────────────────────────────────────────

/** GET /api/net/net-mode — values like "00" are coerced to 0 by the XML parser */
export const netModeSchema = z.object({
  NetworkMode: z.union([z.string(), z.number()]).transform(String),
  NetworkBand: z.union([z.string(), z.number()]).transform(String),
  LTEBand: z.union([z.string(), z.number()]).transform(String),
})

// ── Device ──────────────────────────────────────────────────────────────────

/** GET /api/device/basic_information */
export const basicInformationSchema = z.object({
  productfamily: z.string().optional(),
  classify: z.string().optional(),
  devicename: z.string().optional(),
  SoftwareVersion: z.string().optional(),
  WebUIVersion: z.string().optional(),
  multimode: z.number().optional(),
  restore_default_status: z.number().optional(),
})

// ── User ────────────────────────────────────────────────────────────────────

/** GET /api/user/state-login */
export const stateLoginSchema = z.object({
  /** -1 = not logged in, 0 = logged in */
  State: z.number(),
  Username: z.string().optional(),
  password_type: z.number().optional(),
  firstlogin: z.number().optional(),
})

/** GET /api/user/hilink_login */
export const hilinkLoginSchema = z.object({
  /** 0 = no password required, 1 = password required */
  hilink_login: z.number(),
})

// ── Dialup ──────────────────────────────────────────────────────────────────

/** GET /api/dialup/connection */
export const dialupConnectionSchema = z.object({
  RoamAutoConnectEnable: z.number().optional(),
  MaxIdelTime: z.number().optional(),
  ConnectMode: z.number(),
  MTU: z.number(),
  auto_dial_switch: z.number().optional(),
  pdp_always_on: z.number().optional(),
})
