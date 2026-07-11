/**
 * Fallback service implementations for Modem.
 *
 * Returned when no protocol adapter provides a given service.
 * Each method rejects with NotSupportedError so callers get a clear error
 * instead of accessing undefined.
 */

import { EventEmitter } from 'node:events'

import { NotSupportedError } from './errors.js'
import type {
  Capabilities,
  Data,
  Device,
  Network,
  Phonebook,
  Radio,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  Traffic,
  Ussd,
  Voice,
} from './protocols/adapter.js'
import type { StkMenu } from './stk-types.js'

export function notSupportedNetwork(protocols: readonly string[]): Network {
  const err = (svc: string) => (): Promise<never> =>
    Promise.reject(new NotSupportedError(svc, protocols))
  return {
    signal: err('network'),
    registration: err('network'),
    operator: err('network'),
  }
}

export function notSupportedSms(protocols: readonly string[]): Sms {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('sms', protocols))
  return { send: err, list: err, read: err, delete: err }
}

export function notSupportedSim(protocols: readonly string[]): Sim {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('sim', protocols))
  return { info: err, iccid: err, imsi: err, enterPin: err }
}

export function notSupportedDevice(protocols: readonly string[]): Device {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('device', protocols))
  return { info: err, imei: err }
}

export function notSupportedVoice(protocols: readonly string[]): Voice {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('voice', protocols))
  return { dial: err, answer: err, hangup: err, dtmf: err, listCalls: err }
}

export function notSupportedUssd(protocols: readonly string[]): Ussd {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('ussd', protocols))
  return { send: err, cancel: err }
}

export function notSupportedTraffic(protocols: readonly string[]): Traffic {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('traffic', protocols))
  return { session: err }
}

export function notSupportedData(protocols: readonly string[]): Data {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('data', protocols))
  return { status: err, contexts: err }
}

export function notSupportedCapabilities(protocols: readonly string[]): Capabilities {
  return { discover: () => Promise.reject(new NotSupportedError('capabilities', protocols)) }
}

export function notSupportedRadio(protocols: readonly string[]): Radio {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('radio', protocols))
  return { functionality: err, setFunctionality: err, lastError: err }
}

export function notSupportedPhonebook(protocols: readonly string[]): Phonebook {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('phonebook', protocols))
  return { selectStorage: err, read: err, find: err, write: err, delete: err }
}

export function notSupportedSystem(protocols: readonly string[]): System {
  return { shell: () => Promise.reject(new NotSupportedError('system', protocols)) }
}

export function notSupportedThermal(protocols: readonly string[]): Thermal {
  const err = (): Promise<never> => Promise.reject(new NotSupportedError('thermal', protocols))
  return { readSensors: err, readCpuFrequency: err, setMaxFrequencyKhz: err }
}

/**
 * STK fallback implementation.
 *
 * Extends EventEmitter so that `modem.stk.on(...)` compiles and works
 * (the EventEmitter is live, it just never fires any STK events).
 * All action methods reject with NotSupportedError.
 */
export class NotSupportedStk extends EventEmitter implements Stk {
  readonly enabled = false
  readonly menu: StkMenu | undefined = undefined
  private readonly _protocols: readonly string[]

  constructor(protocols: readonly string[]) {
    super()
    this._protocols = protocols
  }

  enable(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  disable(): void {
    // nothing to do
  }

  select(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  confirm(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  input(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  key(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  back(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }

  endSession(): Promise<void> {
    return Promise.reject(new NotSupportedError('stk', this._protocols))
  }
}
