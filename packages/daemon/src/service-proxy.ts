/**
 * Service proxy: dispatches JSON-RPC method calls to Modem service methods.
 *
 * Maps 'sms.send' -> modem.sms.send(to, text), etc.
 * All Zod validation happens here before calling the actual service.
 *
 * Important: never extract methods from service objects and call them
 * as standalone functions — `this` binding is lost in strict mode.
 * Always call methods on their owning object: `service.method()`.
 */

import type { Modem } from 'cellary'

import {
  deviceIdSchema,
  selectOperatorSchema,
  simEnterPinSchema,
  smsDeleteSchema,
  smsListSchema,
  smsReadSchema,
  smsSendSchema,
  stkInputSchema,
  stkKeySchema,
  stkSelectSchema,
  systemSetTtlSchema,
  systemShellSchema,
  thermalSetMaxFreqSchema,
  ussdSendSchema,
  voiceDialSchema,
  voiceDtmfSchema,
} from './ipc/protocol.js'

// ── Types ──────────────────────────────────────────────────────────────────

export type ModemResolver = (deviceId: string) => Modem

interface MethodEntry {
  readonly resolve: (modem: Modem, params: unknown) => Promise<unknown>
  readonly parseDeviceId: (params: unknown) => string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function notSupported(name: string): Error {
  const err = new Error(`Method '${name}' is not supported by this device`)
  err.name = 'NotSupportedError'
  return err
}

function requireService<T>(service: T | undefined, name: string): T {
  if (service === undefined) {
    const err = new Error(`Service '${name}' is not available on this device`)
    err.name = 'NotSupportedError'
    throw err
  }
  return service
}

// ── Method registry ────────────────────────────────────────────────────────

const METHODS: Record<string, MethodEntry> = {
  // ── Device ─────────────────────────────────────────────────────────
  'device.info': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.device.info(),
  },
  'device.imei': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.device.imei(),
  },
  'device.temperature': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      if (m.device.temperature === undefined) throw notSupported('device.temperature')
      return m.device.temperature()
    },
  },

  // ── Network ────────────────────────────────────────────────────────
  'network.signal': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.network.signal(),
  },
  'network.registration': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.network.registration(),
  },
  'network.operator': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.network.operator(),
  },
  'network.scan': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.scanNetworks(),
  },
  'network.selectOperator': {
    parseDeviceId: (p) => selectOperatorSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { plmn } = selectOperatorSchema.parse(p)
      return m.selectNetwork(plmn)
    },
  },
  'network.selectAutomatic': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.selectNetworkAutomatic(),
  },

  // ── SMS ────────────────────────────────────────────────────────────
  'sms.send': {
    parseDeviceId: (p) => smsSendSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { to, text } = smsSendSchema.parse(p)
      return m.sms.send(to, text)
    },
  },
  'sms.list': {
    parseDeviceId: (p) => smsListSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { status } = smsListSchema.parse(p)
      return m.sms.list(status)
    },
  },
  'sms.read': {
    parseDeviceId: (p) => smsReadSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { index } = smsReadSchema.parse(p)
      return m.sms.read(index)
    },
  },
  'sms.delete': {
    parseDeviceId: (p) => smsDeleteSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { index } = smsDeleteSchema.parse(p)
      return m.sms.delete(index)
    },
  },
  'sms.count': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      const sms = requireService(m.sms, 'sms')
      if (sms.count === undefined) throw notSupported('sms.count')
      return sms.count()
    },
  },

  // ── SIM ────────────────────────────────────────────────────────────
  'sim.info': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.sim.info(),
  },
  'sim.iccid': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.sim.iccid(),
  },
  'sim.imsi': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.sim.imsi(),
  },
  'sim.enterPin': {
    parseDeviceId: (p) => simEnterPinSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { pin } = simEnterPinSchema.parse(p)
      return m.sim.enterPin(pin)
    },
  },
  'sim.phoneNumber': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      if (m.sim.phoneNumber === undefined) throw notSupported('sim.phoneNumber')
      return m.sim.phoneNumber()
    },
  },

  // ── Voice ──────────────────────────────────────────────────────────
  'voice.dial': {
    parseDeviceId: (p) => voiceDialSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { number } = voiceDialSchema.parse(p)
      return requireService(m.voice, 'voice').dial(number)
    },
  },
  'voice.answer': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.voice, 'voice').answer(),
  },
  'voice.hangup': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.voice, 'voice').hangup(),
  },
  'voice.dtmf': {
    parseDeviceId: (p) => voiceDtmfSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { tones } = voiceDtmfSchema.parse(p)
      return requireService(m.voice, 'voice').dtmf(tones)
    },
  },
  'voice.listCalls': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.voice, 'voice').listCalls(),
  },

  // ── USSD ───────────────────────────────────────────────────────────
  'ussd.send': {
    parseDeviceId: (p) => ussdSendSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { code } = ussdSendSchema.parse(p)
      return requireService(m.ussd, 'ussd').send(code)
    },
  },
  'ussd.cancel': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.ussd, 'ussd').cancel(),
  },

  // ── Traffic ────────────────────────────────────────────────────────
  'traffic.session': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.traffic, 'traffic').session(),
  },
  'traffic.monthly': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      const traffic = requireService(m.traffic, 'traffic')
      if (traffic.monthly === undefined) throw notSupported('traffic.monthly')
      return traffic.monthly()
    },
  },

  // ── Data ─────────────────────────────────────────────────────────
  'data.status': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.data, 'data').status(),
  },
  'data.contexts': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.data, 'data').contexts(),
  },

  // ── STK ──────────────────────────────────────────────────────────
  'stk.enable': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.stk.enable(),
  },
  'stk.disable': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      m.stk.disable()
      return Promise.resolve()
    },
  },
  'stk.select': {
    parseDeviceId: (p) => stkSelectSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { itemId } = stkSelectSchema.parse(p)
      return m.stk.select(itemId)
    },
  },
  'stk.confirm': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.stk.confirm(),
  },
  'stk.input': {
    parseDeviceId: (p) => stkInputSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { text } = stkInputSchema.parse(p)
      return m.stk.input(text)
    },
  },
  'stk.key': {
    parseDeviceId: (p) => stkKeySchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { char } = stkKeySchema.parse(p)
      return m.stk.key(char)
    },
  },
  'stk.back': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.stk.back(),
  },
  'stk.endSession': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => m.stk.endSession(),
  },
  'stk.state': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => Promise.resolve({ enabled: m.stk.enabled, menu: m.stk.menu }),
  },

  // ── Capabilities ──────────────────────────────────────────────────
  'capabilities.discover': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.capabilities, 'capabilities').discover(),
  },

  // ── System ─────────────────────────────────────────────────────────
  'system.shell': {
    parseDeviceId: (p) => systemShellSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { command } = systemShellSchema.parse(p)
      return requireService(m.system, 'system').shell(command)
    },
  },
  'system.setTtl': {
    parseDeviceId: (p) => systemSetTtlSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { ttl } = systemSetTtlSchema.parse(p)
      const system = requireService(m.system, 'system')
      if (system.setTtl === undefined) throw notSupported('system.setTtl')
      return system.setTtl(ttl)
    },
  },
  'system.getTtl': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => {
      const system = requireService(m.system, 'system')
      if (system.getTtl === undefined) throw notSupported('system.getTtl')
      return system.getTtl()
    },
  },

  // ── Thermal ────────────────────────────────────────────────────────
  'thermal.readSensors': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.thermal, 'thermal').readSensors(),
  },
  'thermal.readCpuFrequency': {
    parseDeviceId: (p) => deviceIdSchema.parse(p).deviceId,
    resolve: (m) => requireService(m.thermal, 'thermal').readCpuFrequency(),
  },
  'thermal.setMaxFrequencyKhz': {
    parseDeviceId: (p) => thermalSetMaxFreqSchema.parse(p).deviceId,
    resolve: (m, p) => {
      const { khz } = thermalSetMaxFreqSchema.parse(p)
      return requireService(m.thermal, 'thermal').setMaxFrequencyKhz(khz)
    },
  },
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Dispatch a device-scoped method call to the appropriate Modem service.
 * Returns undefined for methods not in the registry.
 */
export function dispatchServiceCall(
  method: string,
  params: unknown,
  resolveModem: ModemResolver,
): Promise<unknown> | undefined {
  // Object.hasOwn, not `method in METHODS`, so inherited Object.prototype keys
  // ('toString', 'constructor', '__proto__') are not mistaken for RPC methods.
  if (!Object.hasOwn(METHODS, method)) return undefined
  const entry = METHODS[method]
  if (!entry) return undefined

  const deviceId = entry.parseDeviceId(params)
  const modem = resolveModem(deviceId)
  return entry.resolve(modem, params)
}

/** Check if a method is a device service call (vs fleet/daemon method). */
export function isServiceMethod(method: string): boolean {
  return Object.hasOwn(METHODS, method)
}
