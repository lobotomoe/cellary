/**
 * Zod schemas for validating daemon RPC responses.
 *
 * Each schema matches a domain type from cellary core. The daemon produces
 * these types via real Modem method calls; we validate at the IPC boundary
 * to catch serialization mismatches early.
 *
 * Field optionality matters: with `exactOptionalPropertyTypes: true`,
 * `{ x?: T }` and `{ x: T | undefined }` are distinct types.
 * - `z.xxx().optional()` produces `{ x?: T | undefined }` -- for fields with `?` in the type
 * - `orUndefined(z.xxx())` produces `{ x: T | undefined }` -- for required-but-nullable fields
 */

import { z } from 'zod'

/**
 * Schema for a required field that accepts `T | undefined`.
 *
 * Unlike `.optional()` which makes the key itself optional (`{ x?: T }`),
 * this keeps the key required but allows undefined as a value.
 * Necessary under `exactOptionalPropertyTypes: true`.
 */
function orUndefined<T>(schema: z.ZodType<T>): z.ZodUnion<[z.ZodType<T>, z.ZodUndefined]> {
  return z.union([schema, z.undefined()])
}

// ── Signal ──────────────────────────────────────────────────────────────────

export const signalInfoSchema = z.object({
  rssi: orUndefined(z.number()),
  bitErrorRate: z.number(),
  technology: z.string().optional(),
  rsrp: z.number().optional(),
  rsrq: z.number().optional(),
  sinr: z.number().optional(),
  band: z.string().optional(),
  rscp: z.number().optional(),
  ecno: z.number().optional(),
})

// ── Registration ────────────────────────────────────────────────────────────

export const registrationInfoSchema = z.object({
  status: z.enum(['notRegistered', 'home', 'searching', 'denied', 'unknown', 'roaming']),
  locationAreaCode: z.string().optional(),
  cellId: z.string().optional(),
  technology: z.string().optional(),
})

// ── Available Networks ──────────────────────────────────────────────────────

export const availableNetworkSchema = z.object({
  status: z.enum(['unknown', 'available', 'current', 'forbidden']),
  name: orUndefined(z.string()),
  shortName: orUndefined(z.string()),
  numeric: z.string(),
  technology: z.string().optional(),
})

// ── SMS ─────────────────────────────────────────────────────────────────────

export const smsMessageSchema = z.object({
  index: z.number(),
  address: z.string(),
  direction: z.enum(['incoming', 'outgoing']),
  text: z.string(),
  // Absent for stored outgoing messages (SMS-SUBMIT has no timestamp).
  timestamp: z.date().optional(),
  status: z.enum(['unread', 'read', 'sent', 'unsent']),
})

export const smsCountSchema = z.object({
  inbox: z.number(),
  capacity: z.number(),
  unread: z.number().optional(),
})

// ── SIM ─────────────────────────────────────────────────────────────────────

export const simInfoSchema = z.object({
  iccid: orUndefined(z.string()),
  imsi: z.string().optional(),
  operator: z.string().optional(),
  state: z.enum([
    'ready',
    'pinRequired',
    'pukRequired',
    'networkLocked',
    'absent',
    'error',
    'unavailable',
  ]),
})

// ── Device ──────────────────────────────────────────────────────────────────

export const deviceInfoSchema = z.object({
  manufacturer: orUndefined(z.string()),
  model: orUndefined(z.string()),
  revision: orUndefined(z.string()),
  imei: orUndefined(z.string()),
  hardwareVersion: z.string().optional(),
})

// ── Voice ───────────────────────────────────────────────────────────────────

export const activeCallSchema = z.object({
  index: z.number(),
  direction: z.enum(['outgoing', 'incoming']),
  state: z.enum(['incoming', 'waiting', 'dialing', 'setup', 'alerting', 'active', 'held', 'ended']),
  mode: z.number(),
  number: z.string().optional(),
})

// ── Thermal ─────────────────────────────────────────────────────────────────

export const thermalReadingSchema = z.object({
  sensor: z.string(),
  celsius: z.number(),
})

export const cpuFrequencySchema = z.object({
  maxKhz: z.number(),
  availableKhz: z.array(z.number()),
  currentKhz: z.number().optional(),
})

// ── Traffic ─────────────────────────────────────────────────────────────────

export const trafficStatsSchema = z.object({
  downloadBytes: z.number(),
  uploadBytes: z.number(),
  durationSeconds: z.number(),
  downloadRate: z.number().optional(),
  uploadRate: z.number().optional(),
})

// ── Data Connection ─────────────────────────────────────────────────────────

export const dataConnectionStatusSchema = z.object({
  state: z.enum(['connected', 'disconnected', 'connecting', 'disconnecting']),
  attached: z.boolean(),
})

export const pdpContextSchema = z.object({
  cid: z.number(),
  pdpType: z.string(),
  apn: orUndefined(z.string()),
  active: z.boolean(),
  address: z.string().optional(),
})

// ── Capabilities ────────────────────────────────────────────────────────────

const smsCapabilitiesSchema = z.object({
  send: z.boolean(),
  receive: z.boolean(),
  read: z.boolean(),
  delete: z.boolean(),
  multipart: z.boolean(),
  modes: z.array(z.string()),
  storage: z.array(z.string()),
})

const voiceCapabilitiesSchema = z.object({
  dial: z.boolean(),
  answer: z.boolean(),
  hangup: z.boolean(),
  dtmf: z.boolean(),
  forwarding: z.boolean(),
  waiting: z.boolean(),
  hold: z.boolean(),
  callerId: z.boolean(),
  clir: z.boolean(),
})

const networkCapabilitiesSchema = z.object({
  signal: z.boolean(),
  registration: z.boolean(),
  operatorScan: z.boolean(),
  gprs: z.boolean(),
  eps: z.boolean(),
})

const simCapabilitiesSchema = z.object({
  imsi: z.boolean(),
  iccid: z.boolean(),
  pin: z.boolean(),
  pinRetries: z.boolean(),
  facilityLock: z.boolean(),
  changePassword: z.boolean(),
  phonebook: z.boolean(),
  genericAccess: z.boolean(),
  restrictedAccess: z.boolean(),
})

const ussdCapabilitiesSchema = z.object({
  supported: z.boolean(),
})

const dataCapabilitiesSchema = z.object({
  pdpContext: z.boolean(),
  types: z.array(z.string()),
})

const stkCapabilitiesSchema = z.object({
  supported: z.boolean(),
})

export const modemCapabilitiesSchema = z.object({
  commands: z.array(z.string()),
  sms: smsCapabilitiesSchema,
  voice: voiceCapabilitiesSchema,
  network: networkCapabilitiesSchema,
  sim: simCapabilitiesSchema,
  ussd: ussdCapabilitiesSchema,
  data: dataCapabilitiesSchema,
  stk: stkCapabilitiesSchema,
})

// ── Provision ───────────────────────────────────────────────────────────────

const transportConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('serial'),
    path: z.string(),
    baudRate: z.number().optional(),
  }),
  z.object({
    type: z.literal('usb'),
    vendorId: z.number(),
    productId: z.number(),
    interfaceNumber: z.number(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string(),
  }),
])

const modemDriverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at') }),
  z.object({ kind: z.literal('vendor'), api: z.string() }),
])

/**
 * Partial provision result validation.
 *
 * ProvisionResult.profile contains DeviceProfile which includes function fields
 * (signal parsers, traffic parsers) that don't survive JSON serialization.
 * We validate the usable parts (transport, driver) and extract the profile name
 * to construct a minimal but type-safe result.
 *
 * The profile returned in remote mode is skeletal -- functions are missing.
 * This is acceptable because CLI commands never use the profile from provision;
 * the daemon uses the real profile internally.
 */
export const provisionResultPartialSchema = z.object({
  transport: transportConfigSchema,
  driver: modemDriverSchema,
  profile: z.object({
    vendorId: z.string().optional(),
    name: z.string(),
  }),
  model: z
    .object({
      name: z.string(),
    })
    .optional(),
})

// ── STK ─────────────────────────────────────────────────────────────────────

const stkMenuItemSchema = z.object({
  id: z.number(),
  label: z.string(),
})

const stkMenuSchema = z.object({
  type: z.literal('menu'),
  title: z.string(),
  items: z.array(stkMenuItemSchema),
})

/** Result of the `stk.state` RPC: whether STK is enabled and the current root menu, if any. */
export const stkStateSchema = z.object({
  enabled: z.boolean(),
  menu: stkMenuSchema.optional(),
})
