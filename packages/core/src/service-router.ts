/**
 * Service routing: scores adapters by declared priority and picks the best
 * provider for each service domain.
 *
 * Extracted from Modem constructor to keep the class focused on lifecycle
 * and event wiring. The routing algorithm is pure: no side effects, no I/O.
 */

import {
  NotSupportedStk,
  notSupportedCapabilities,
  notSupportedData,
  notSupportedDevice,
  notSupportedNetwork,
  notSupportedPhonebook,
  notSupportedRadio,
  notSupportedSim,
  notSupportedSms,
  notSupportedSystem,
  notSupportedThermal,
  notSupportedTraffic,
  notSupportedUssd,
  notSupportedVoice,
} from './fallback-services.js'
import type { Logger } from './logger.js'
import type {
  Capabilities,
  Data,
  Device,
  Network,
  Phonebook,
  ProtocolAdapter,
  Radio,
  ServiceName,
  ServiceRouteInfo,
  Sim,
  Sms,
  Stk,
  System,
  Thermal,
  Traffic,
  Ussd,
  Voice,
} from './protocols/adapter.js'

// ── Routed services result ──────────────────────────────────────────────────

export interface RoutedServices {
  readonly network: Network
  readonly sms: Sms
  readonly sim: Sim
  readonly device: Device
  readonly voice: Voice
  readonly ussd: Ussd
  readonly traffic: Traffic
  readonly data: Data
  readonly radio: Radio
  readonly capabilities: Capabilities
  readonly stk: Stk
  readonly phonebook: Phonebook
  readonly system: System
  readonly thermal: Thermal
  readonly routeInfo: Readonly<Record<string, ServiceRouteInfo>>
}

// ── Routing algorithm ───────────────────────────────────────────────────────

/**
 * Pick the best adapter for a service based on declared priorities.
 *
 * Highest priority wins. Ties broken by adapter array order (strict `>`,
 * so the first candidate wins when priorities are equal).
 */
function pickService<T>(
  adapters: readonly ProtocolAdapter[],
  serviceName: ServiceName,
  extract: (a: ProtocolAdapter) => T | undefined,
): { value: T; info: ServiceRouteInfo } | undefined {
  let bestValue: T | undefined
  let bestKind = ''
  let bestPriority = -Infinity
  let bestReason = ''
  let candidateCount = 0

  for (const adapter of adapters) {
    const value = extract(adapter)
    if (value === undefined) continue

    candidateCount++
    const cap = adapter.serviceCapabilities?.()[serviceName]
    const priority = cap?.priority ?? 0

    if (priority > bestPriority) {
      bestValue = value
      bestKind = adapter.kind
      bestPriority = priority
      bestReason = cap?.reason ?? ''
    }
  }

  if (bestValue === undefined) return undefined

  return {
    value: bestValue,
    info: {
      adapter: bestKind,
      reason: bestReason,
      contested: candidateCount > 1,
    },
  }
}

// ── Route all services ──────────────────────────────────────────────────────

/**
 * Route each service to the best adapter by declared priority.
 *
 * Services without a matching adapter get a NotSupported fallback that
 * rejects with `NotSupportedError`. STK always returns a live EventEmitter
 * (either the real implementation or NotSupportedStk).
 */
export function routeServices(
  adapters: readonly ProtocolAdapter[],
  proto: readonly string[],
  log: Logger,
): RoutedServices {
  const routeInfo: Record<string, ServiceRouteInfo> = {}

  // ── Network ─────────────────────────────────────────────────────────────
  const net = pickService(adapters, 'network', (a) => a.network)
  const network = net?.value ?? notSupportedNetwork(proto)
  if (net !== undefined) routeInfo.network = net.info

  // ── SMS (with smsCount enrichment) ──────────────────────────────────────
  const smsResult = pickService(adapters, 'sms', (a) => a.sms)
  let sms = smsResult?.value ?? notSupportedSms(proto)

  // Enrich: if primary sms has no count(), use any adapter's smsCount
  if (sms.count === undefined) {
    for (const adapter of adapters) {
      if (adapter.smsCount !== undefined) {
        const countFn = adapter.smsCount.bind(adapter)
        sms = { ...sms, count: countFn }
        break
      }
    }
  }

  if (smsResult !== undefined) routeInfo.sms = smsResult.info

  // ── SIM ─────────────────────────────────────────────────────────────────
  const simResult = pickService(adapters, 'sim', (a) => a.sim)
  const sim = simResult?.value ?? notSupportedSim(proto)
  if (simResult !== undefined) routeInfo.sim = simResult.info

  // ── Device ──────────────────────────────────────────────────────────────
  const dev = pickService(adapters, 'device', (a) => a.device)
  const device = dev?.value ?? notSupportedDevice(proto)
  if (dev !== undefined) routeInfo.device = dev.info

  // ── Voice ───────────────────────────────────────────────────────────────
  const voi = pickService(adapters, 'voice', (a) => a.voice)
  const voice = voi?.value ?? notSupportedVoice(proto)
  if (voi !== undefined) routeInfo.voice = voi.info

  // ── USSD ────────────────────────────────────────────────────────────────
  const ussdResult = pickService(adapters, 'ussd', (a) => a.ussd)
  const ussd = ussdResult?.value ?? notSupportedUssd(proto)
  if (ussdResult !== undefined) routeInfo.ussd = ussdResult.info

  // ── Traffic ─────────────────────────────────────────────────────────────
  const traf = pickService(adapters, 'traffic', (a) => a.traffic)
  const traffic = traf?.value ?? notSupportedTraffic(proto)
  if (traf !== undefined) routeInfo.traffic = traf.info

  // ── Data ────────────────────────────────────────────────────────────────
  const dat = pickService(adapters, 'data', (a) => a.data)
  const data = dat?.value ?? notSupportedData(proto)
  if (dat !== undefined) routeInfo.data = dat.info

  // ── Radio ───────────────────────────────────────────────────────────────
  const rad = pickService(adapters, 'radio', (a) => a.radio)
  const radio = rad?.value ?? notSupportedRadio(proto)
  if (rad !== undefined) routeInfo.radio = rad.info

  // ── Capabilities ────────────────────────────────────────────────────────
  const cap = pickService(adapters, 'capabilities', (a) => a.capabilities)
  const capabilities = cap?.value ?? notSupportedCapabilities(proto)
  if (cap !== undefined) routeInfo.capabilities = cap.info

  // ── STK (always a live EventEmitter) ────────────────────────────────────
  const stkResult = pickService(adapters, 'stk', (a) => a.stk)
  const stk = stkResult?.value ?? new NotSupportedStk(proto)
  if (stkResult !== undefined) routeInfo.stk = stkResult.info

  // ── Phonebook ───────────────────────────────────────────────────────────
  const pb = pickService(adapters, 'phonebook', (a) => a.phonebook)
  const phonebook = pb?.value ?? notSupportedPhonebook(proto)
  if (pb !== undefined) routeInfo.phonebook = pb.info

  // ── System ──────────────────────────────────────────────────────────────
  const sys = pickService(adapters, 'system', (a) => a.system)
  const system = sys?.value ?? notSupportedSystem(proto)
  if (sys !== undefined) routeInfo.system = sys.info

  // ── Thermal ─────────────────────────────────────────────────────────────
  const therm = pickService(adapters, 'thermal', (a) => a.thermal)
  const thermal = therm?.value ?? notSupportedThermal(proto)
  if (therm !== undefined) routeInfo.thermal = therm.info

  // ── Logging ─────────────────────────────────────────────────────────────
  for (const [service, route] of Object.entries(routeInfo)) {
    log.debug('Service routed', {
      service,
      adapter: route.adapter,
      reason: route.reason,
      contested: route.contested,
    })
  }

  return {
    network,
    sms,
    sim,
    device,
    voice,
    ussd,
    traffic,
    data,
    radio,
    capabilities,
    stk,
    phonebook,
    system,
    thermal,
    routeInfo,
  }
}
