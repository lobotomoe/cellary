/**
 * JSON-RPC 2.0 protocol types for the cellary daemon IPC.
 *
 * All messages are newline-delimited JSON over Unix socket (macOS/Linux)
 * or named pipe (Windows).
 *
 * Client -> Daemon: JSON-RPC requests (method + params)
 * Daemon -> Client: JSON-RPC responses + notifications (events)
 */

import { z } from 'zod'

// ── JSON-RPC 2.0 base types ────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number | string
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | string | null
  readonly result?: unknown
  readonly error?: JsonRpcError | undefined
}

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** Server-initiated notification (no id, no response expected). */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

// ── Error codes ────────────────────────────────────────────────────────────

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Device not found or not ready. */
  DEVICE_NOT_FOUND: -32000,
  /** Service not available on this device. */
  SERVICE_UNAVAILABLE: -32001,
  /** Operation failed (modem error, transport error, etc.). */
  OPERATION_FAILED: -32002,
} as const

// ── Serializable device types ──────────────────────────────────────────────

/**
 * Serializable readiness stage for IPC.
 * Strips non-serializable fields (Modem instance, Error objects).
 */
export type IpcReadinessStage =
  | 'detected'
  | 'assessing'
  | 'preparing'
  | 'connecting'
  | 'checking'
  | 'ready'
  | 'degraded'
  | 'error'
  | 'offline'

/**
 * Discovery-time information serialized for IPC.
 *
 * Mirrors the essential fields of core's DiscoveredModem without
 * non-serializable fields (entry, functions). The CLI reconstructs
 * a DiscoveredModem from this data for display and provisioning.
 */
export type IpcDiscoveryMode =
  | 'emergency'
  | 'download'
  | 'storage'
  | 'modem-usb'
  | 'http'
  | 'serial'

export interface IpcDiscoveryInfo {
  readonly mode: IpcDiscoveryMode
  readonly productId: number
  /** USB bus number. Absent for serial devices. */
  readonly busNumber?: number | undefined
  /** USB port path. Absent for serial devices. */
  readonly portNumbers?: readonly number[] | undefined
  /** Vendor HTTP API URL. Present only for mode 'http'. */
  readonly url?: string | undefined
  /** Serial port path. Present only for mode 'serial'. */
  readonly path?: string | undefined
}

export interface IpcDeviceInfo {
  readonly deviceId: string
  readonly vendorId: number
  readonly name: string
  readonly stage: IpcReadinessStage
  /** Error message when stage === 'error'. */
  readonly error?: string | undefined
  /** Whether the error is recoverable (device may retry). */
  readonly recoverable?: boolean | undefined
  /** First seen timestamp. Transported as Date via superjson. */
  readonly firstSeenAt: Date
  /** Discovery snapshot from the current USB cycle. Undefined when device has no active cycle. */
  readonly discovery?: IpcDiscoveryInfo | undefined
  /** Model name when device is ready/degraded (e.g. "Huawei E3372"). */
  readonly modelName?: string | undefined
  /** Active protocol adapter kinds (e.g. ['at', 'hilink']). Present when ready/degraded. */
  readonly protocols?: readonly string[] | undefined
  /** Vendor HTTP API URL. Present when modem has an HTTP adapter. */
  readonly httpUrl?: string | undefined
  /** Service routing map: which protocol handles each service. */
  readonly serviceRouting?:
    | Readonly<Record<string, { adapter: string; reason: string; contested: boolean }>>
    | undefined
}

// ── Request parameter schemas ──────────────────────────────────────────────

export const deviceIdSchema = z.object({
  deviceId: z.string(),
})

export const smsSendSchema = z.object({
  deviceId: z.string(),
  to: z.string(),
  text: z.string(),
})

export const smsListSchema = z.object({
  deviceId: z.string(),
  status: z.enum(['all', 'unread', 'read', 'sent', 'unsent']).optional(),
})

export const smsReadSchema = z.object({
  deviceId: z.string(),
  index: z.number(),
})

export const smsDeleteSchema = z.object({
  deviceId: z.string(),
  index: z.number(),
})

export const voiceDialSchema = z.object({
  deviceId: z.string(),
  number: z.string(),
})

export const voiceDtmfSchema = z.object({
  deviceId: z.string(),
  tones: z.string(),
})

export const ussdSendSchema = z.object({
  deviceId: z.string(),
  code: z.string(),
})

export const simEnterPinSchema = z.object({
  deviceId: z.string(),
  pin: z.string(),
})

export const subscribeSchema = z.object({
  deviceId: z.string(),
  events: z.array(z.string()),
})

export const waitForReadySchema = z.object({
  timeoutMs: z.number().optional(),
  /** Wait for this specific device (stable deviceId). Omit to wait for any. */
  deviceId: z.string().optional(),
})

export const provisionSchema = z.object({
  deviceId: z.string(),
})

export const systemShellSchema = z.object({
  deviceId: z.string(),
  command: z.string(),
})

export const systemSetTtlSchema = z.object({
  deviceId: z.string(),
  ttl: z.number(),
})

export const thermalSetMaxFreqSchema = z.object({
  deviceId: z.string(),
  khz: z.number(),
})

export const selectOperatorSchema = z.object({
  deviceId: z.string(),
  plmn: z.string(),
})

export const stkSelectSchema = z.object({
  deviceId: z.string(),
  itemId: z.number(),
})

export const stkInputSchema = z.object({
  deviceId: z.string(),
  text: z.string(),
})

export const stkKeySchema = z.object({
  deviceId: z.string(),
  char: z.string(),
})

// ── Method registry ────────────────────────────────────────────────────────

/**
 * All supported RPC methods.
 *
 * Methods prefixed with a service name map to Modem service calls.
 * Methods prefixed with 'devices.' are fleet management.
 * Methods prefixed with 'daemon.' are daemon lifecycle.
 */
export type RpcMethod =
  // Fleet management
  | 'devices.list'
  | 'devices.waitForReady'
  | 'devices.provision'

  // Device services
  | 'device.info'
  | 'device.imei'
  | 'device.temperature'

  // Network
  | 'network.signal'
  | 'network.registration'
  | 'network.operator'
  | 'network.scan'
  | 'network.selectOperator'
  | 'network.selectAutomatic'

  // SMS
  | 'sms.send'
  | 'sms.list'
  | 'sms.read'
  | 'sms.delete'
  | 'sms.count'

  // SIM
  | 'sim.info'
  | 'sim.iccid'
  | 'sim.imsi'
  | 'sim.enterPin'
  | 'sim.phoneNumber'

  // Voice
  | 'voice.dial'
  | 'voice.answer'
  | 'voice.hangup'
  | 'voice.dtmf'
  | 'voice.listCalls'

  // USSD
  | 'ussd.send'
  | 'ussd.cancel'

  // Traffic
  | 'traffic.session'
  | 'traffic.monthly'

  // Data
  | 'data.status'
  | 'data.contexts'

  // STK
  | 'stk.enable'
  | 'stk.disable'
  | 'stk.select'
  | 'stk.confirm'
  | 'stk.input'
  | 'stk.key'
  | 'stk.back'
  | 'stk.endSession'
  | 'stk.state'

  // Capabilities
  | 'capabilities.discover'

  // System
  | 'system.shell'
  | 'system.setTtl'
  | 'system.getTtl'

  // Streams
  | 'stream.open'

  // Subscriptions
  | 'subscribe'
  | 'unsubscribe'

  // Daemon management
  | 'daemon.status'
  | 'daemon.shutdown'

// ── Event notification types ───────────────────────────────────────────────

export interface IpcEventNotification {
  readonly deviceId: string
  readonly event: string
  readonly data: unknown
}

export interface DaemonStatus {
  readonly uptime: number
  readonly deviceCount: number
  readonly pid: number
  readonly version: string
}

// ── Incoming message schemas (client-side validation) ─────────────────────

/** Validates a JSON-RPC response from daemon. */
export const jsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
})

/** Validates a JSON-RPC notification from daemon. */
export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
})

/** Validates an IPC event notification payload. */
export const ipcEventNotificationSchema = z.object({
  deviceId: z.string(),
  event: z.string(),
  data: z.unknown(),
})

const IPC_READINESS_STAGES = [
  'detected',
  'assessing',
  'preparing',
  'connecting',
  'checking',
  'ready',
  'degraded',
  'error',
  'offline',
] as const

const IPC_DISCOVERY_MODES = [
  'emergency',
  'download',
  'storage',
  'modem-usb',
  'http',
  'serial',
] as const

/** Validates IpcDiscoveryInfo from daemon responses. */
export const ipcDiscoveryInfoSchema = z.object({
  mode: z.enum(IPC_DISCOVERY_MODES),
  productId: z.number(),
  busNumber: z.number().optional(),
  portNumbers: z.array(z.number()).optional(),
  url: z.string().optional(),
  path: z.string().optional(),
})

/** Validates IpcDeviceInfo from daemon responses. */
export const ipcDeviceInfoSchema = z.object({
  deviceId: z.string(),
  vendorId: z.number(),
  name: z.string(),
  stage: z.enum(IPC_READINESS_STAGES),
  error: z.string().optional(),
  recoverable: z.boolean().optional(),
  firstSeenAt: z.date(),
  discovery: ipcDiscoveryInfoSchema.optional(),
  modelName: z.string().optional(),
  protocols: z.array(z.string()).optional(),
  httpUrl: z.string().optional(),
  serviceRouting: z
    .record(
      z.string(),
      z.object({ adapter: z.string(), reason: z.string(), contested: z.boolean() }),
    )
    .optional(),
})

/** Validates DaemonStatus from daemon responses. */
export const daemonStatusSchema = z.object({
  uptime: z.number(),
  deviceCount: z.number(),
  pid: z.number(),
  version: z.string(),
})

// ── Socket paths ───────────────────────────────────────────────────────────

const SOCKET_DIR_MACOS = '/var/run'
const SOCKET_DIR_LINUX = '/run'
const PIPE_NAME_WINDOWS = '\\\\.\\pipe\\cellaryd'

const socketEnvSchema = z.string().min(1).optional()

export function getSocketPath(): string {
  const envPath = socketEnvSchema.parse(process.env.CELLARY_SOCKET)
  if (envPath !== undefined) return envPath
  if (process.platform === 'win32') return PIPE_NAME_WINDOWS
  const dir = process.platform === 'darwin' ? SOCKET_DIR_MACOS : SOCKET_DIR_LINUX
  return `${dir}/cellaryd.sock`
}
