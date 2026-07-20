import type { AuditSink } from '../../audit.js'
import { DiscoveryError } from '../../errors.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import type { ProtocolAdapter, VendorPlugin } from '../../protocols/adapter.js'
import type { AdbShell } from '../../protocols/adb/index.js'
import type { AtAdapter as AtAdapterType } from '../../protocols/at/index.js'
import type { DeviceProfile, ModelInfo } from '../../types.js'
import { diagnoseHuawei } from './diagnostics.js'
import { resolveHiLinkModel } from './model-registry.js'
import { E3372_PID_STICK } from './platforms/balong/models/e3372/index.js'
import { E8372_STATE_CONFIG } from './platforms/balong/models/e8372/index.js'
import { decodeHuaweiURC } from './urc-decoder.js'
import { interpretHuaweiURC } from './urc-interpreter.js'

const HILINK_PROBE_TIMEOUT_MS = 3_000
const ADB_PROBE_TIMEOUT_MS = 3_000
const ADB_PORT = 5555

/** Factory default credentials on all Huawei HiLink devices (printed on device label). */
export const HILINK_DEFAULT_CREDENTIALS = { password: 'admin', username: 'admin' } as const

/**
 * Huawei vendor plugin.
 *
 * Discovers all protocol adapters for Huawei hardware. For devices that expose
 * both AT (serial/USB) and HiLink HTTP simultaneously (e.g. E8372 @ PID 0x1566),
 * returns both adapters. Per-service routing is determined by each adapter's
 * serviceCapabilities() declaration (e.g. HiLink wins for network signal,
 * AT wins for USSD since it doesn't require authentication).
 *
 * For HTTP-only devices (e.g. E8372 @ PID 0x14db), returns only HiLinkAdapter.
 */
export const huaweiPlugin: VendorPlugin = {
  vendorId: 'huawei',
  name: 'Huawei',

  async discoverAdapters(transport, profile, model, opts) {
    const log = opts?.logger ?? noopLogger
    const { HiLinkAdapter } = await import('./protocols/hilink/adapter.js')
    const { fetchHiLinkSession } = await import('./protocols/hilink/index.js')

    // HTTP-only device (e.g. PID 0x14db): HiLink is the only protocol available.
    // Probe reachability before returning — a broken adapter helps nobody.
    if (transport.type === 'http') {
      log.info('Probing HiLink (HTTP-only)', { url: transport.url })
      const timeout = new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), HILINK_PROBE_TIMEOUT_MS),
      )
      const probe = fetchHiLinkSession(transport.url)
        .then(() => true)
        .catch(() => false)

      const reachable = await Promise.race([probe, timeout])
      if (!reachable) {
        log.error('HiLink unreachable', { url: transport.url })
        throw new DiscoveryError(
          `Cannot reach HiLink API at ${transport.url}. ` +
            'This device is in HiLink-only mode and requires HTTP access to function.\n' +
            'On macOS, the network interface for this device may not be available.\n' +
            'Try: reconnect the device, or use it on Linux where CDC-ECM works.',
        )
      }

      log.info('HiLink reachable', { url: transport.url })
      const adapters: ProtocolAdapter[] = [
        new HiLinkAdapter(
          transport.url,
          HILINK_DEFAULT_CREDENTIALS,
          log.child({ adapter: 'hilink' }),
        ),
      ]

      // Probe ADB on the same network (HiLink devices run Android with adbd)
      const adbResult = await probeAndCreateAdb(transport.url, profile, model, log, opts?.auditSink)
      if (adbResult !== undefined) {
        adapters.push(...adbResult.adapters)
      }

      // Runtime model resolution via basic_information.
      // Shared PIDs (0x14db) cannot identify the model at USB level.
      // The HiLink API is the only reliable source of truth.
      const resolvedModel = await resolveModelFromHiLink(transport.url, log)

      return resolvedModel !== undefined ? { adapters, model: resolvedModel } : { adapters }
    }

    // AT-capable device (serial or USB): open AT adapter, then probe for HiLink
    const { AtAdapter } = await import('../../protocols/at/index.js')
    log.info('Connecting AT adapter', { transport: transport.type })
    const atOpts = { ...opts, messageInterpreter: interpretHuaweiURC }
    const atAdapter = await AtAdapter.connect(transport, profile, atOpts, model)

    // Skip HiLink probe for PIDs known to be AT-only (e.g. E3372 stick mode).
    // The probe is non-fatal but costs 3s on timeout -- wasteful for AT-only devices.
    const isAtOnly = transport.type === 'usb' && transport.productId === E3372_PID_STICK

    const baseUrl = E8372_STATE_CONFIG.baseUrl
    let hiLinkReachable = false

    if (isAtOnly) {
      log.info('Skipping HiLink probe (AT-only PID)', {
        productId: transport.productId,
      })
    } else {
      log.info('Probing HiLink', { url: baseUrl })
      const timeout = new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), HILINK_PROBE_TIMEOUT_MS),
      )
      const probe = fetchHiLinkSession(baseUrl)
        .then(() => true)
        .catch(() => false)

      hiLinkReachable = await Promise.race([probe, timeout])
      log.info('HiLink probe result', { reachable: hiLinkReachable })
    }

    // Both protocols available: per-service priorities declared in serviceCapabilities()
    const adapters: ProtocolAdapter[] = hiLinkReachable
      ? [
          new HiLinkAdapter(baseUrl, HILINK_DEFAULT_CREDENTIALS, log.child({ adapter: 'hilink' })),
          atAdapter,
        ]
      : [atAdapter]

    // Probe ADB if HiLink is reachable (same CDC-ECM network)
    if (hiLinkReachable) {
      const adbResult = await probeAndCreateAdb(baseUrl, profile, model, log, opts?.auditSink)
      if (adbResult !== undefined) adapters.push(...adbResult.adapters)
    }

    return { adapters }
  },

  decodeMessage: decodeHuaweiURC,

  diagnose: diagnoseHuawei,

  preparationProfile(_discovered, model) {
    return model?.prepProfile
  },

  async identify(discovered) {
    if (discovered.mode === 'http') {
      // Probe HiLink basic_information for model name (unauthenticated)
      const displayName = await probeHiLinkDeviceName(discovered.url)
      // ADB provides internal AT serial (priority 10), hilink is fallback (priority 0)
      return { displayName, protocols: ['adb', 'hilink'] }
    }
    if (discovered.mode === 'modem-usb') {
      if ('productId' in discovered && discovered.productId === E3372_PID_STICK) {
        return { protocols: ['at'] }
      }
      // AT + HiLink + optional ADB
      return { protocols: ['at', 'hilink', 'adb'] }
    }
    return undefined
  },
}

// ── ADB probe helper ────────────────────────────────────────────────────────

/** Balong internal AT serial device. */
const BALONG_APPVCOM = '/dev/appvcom1'

interface AdbProbeResult {
  readonly adapters: readonly ProtocolAdapter[]
  /** AtAdapter created over ADB serial transport, if internal COM port was available. */
  readonly atAdapter?: AtAdapterType | undefined
}

/**
 * Probe ADB and create adapters.
 *
 * When the device has an internal serial port (e.g. /dev/appvcom1 on Balong):
 * - Creates a full AtAdapter over ADB serial transport (SMS, Voice, Network...)
 * - Creates AdbAdapter with System service only (shell, TTL, persist)
 *
 * When no internal serial is available (fallback):
 * - Creates AdbAdapter with BalongAtBridge + BalongDevice for one-shot AT queries
 */
async function probeAndCreateAdb(
  httpUrl: string,
  profile: DeviceProfile,
  model: ModelInfo | undefined,
  log: Logger,
  auditSink?: AuditSink,
): Promise<AdbProbeResult | undefined> {
  const { probeAdb } = await import('../../protocols/adb/index.js')

  // Extract host from HTTP URL (e.g. 'http://192.168.8.1' -> '192.168.8.1')
  const host = new URL(httpUrl).hostname
  log.info('Probing ADB', { host, port: ADB_PORT })

  const shell = await probeAdb(
    host,
    ADB_PORT,
    ADB_PROBE_TIMEOUT_MS,
    log.child({ probe: 'adb' }),
    auditSink,
  )
  if (shell === undefined) {
    log.info('ADB not available', { host })
    return undefined
  }

  log.info('ADB reachable', { host })

  // Probe for internal serial device
  const serialAvailable = await probeSerialDevice(shell, BALONG_APPVCOM, log)

  if (serialAvailable) {
    return createAdbWithSerialAt(shell, BALONG_APPVCOM, profile, model, log, auditSink)
  }

  // Fallback: no internal serial, use one-shot AT bridge
  return createAdbWithBridge(shell, log)
}

/**
 * Probe whether an internal serial device exists AND is responsive.
 *
 * Checks both file existence and functional availability. On some Balong
 * devices (e.g. E5573), /dev/appvcom1 exists but the modem DSP doesn't
 * respond — writes block forever. We detect this by backgrounding a write
 * and checking if it completes within 2 seconds.
 */
async function probeSerialDevice(
  shell: AdbShell,
  devicePath: string,
  log: Logger,
): Promise<boolean> {
  try {
    // Step 1: check device node exists
    const exists = await shell.exec(`test -c ${devicePath} && echo ok`, 3_000)
    if (exists.stdout.trim() !== 'ok') {
      log.info('Internal serial not found', { devicePath })
      return false
    }

    // Step 2: functional probe — write AT in background, check if it completes.
    // If kill succeeds after 2s, the write was still blocked (DSP unresponsive).
    const probe = [
      `echo -ne 'AT\\r' > ${devicePath} &`,
      'W=$!',
      'sleep 2',
      'kill $W 2>/dev/null && echo dead || echo alive',
    ].join('\n')

    const result = await shell.exec(probe, 5_000)
    const responsive = result.stdout.trim() === 'alive'
    log.info('Internal serial probe', { devicePath, responsive })
    return responsive
  } catch {
    log.debug('Serial device probe failed', { devicePath })
    return false
  }
}

/**
 * Create adapters with full AT over ADB serial transport.
 *
 * The serial transport opens a persistent bidirectional stream to the
 * internal COM port. ATChannel + all services work natively over it.
 * AdbAdapter provides System service only (shell, TTL).
 */
async function createAdbWithSerialAt(
  shell: AdbShell,
  devicePath: string,
  profile: DeviceProfile,
  model: ModelInfo | undefined,
  log: Logger,
  auditSink?: AuditSink,
): Promise<AdbProbeResult> {
  const { AdbAdapter } = await import('../../protocols/adb/adapter.js')
  const { AdbSerialTransport } = await import('../../protocols/adb/serial-transport.js')
  const { AtAdapter, requireAtConfig } = await import('../../protocols/at/index.js')
  const { ATChannel } = await import('../../protocols/at/channel/at-channel.js')

  const atConfig = requireAtConfig(profile)
  log.info('Creating AT adapter over ADB serial', { devicePath })

  const transport = new AdbSerialTransport({
    connection: shell.connection,
    devicePath,
    preOpenCommands: ['AT^CURC=0'],
  })

  const channel = new ATChannel(transport, {
    urcPrefixes: [...atConfig.urcPrefixes],
    defaultTimeout: 10_000,
    commandTimeouts: atConfig.commandTimeouts,
    logger: log.child({ adapter: 'at-adb' }),
    auditSink,
  })

  await transport.open()
  const atAdapter = new AtAdapter(transport, channel, atConfig, model)

  // AdbAdapter with System service only -- AT is handled by AtAdapter
  const adbAdapter = new AdbAdapter(shell, log.child({ adapter: 'adb' }))

  return { adapters: [atAdapter, adbAdapter], atAdapter }
}

/**
 * Fallback: create AdbAdapter with one-shot AT bridge.
 *
 * Used when the internal serial device is not available. The bridge
 * provides System.executeAt() for direct AT queries but not full
 * AT services (no SMS, Voice, etc.).
 */
async function createAdbWithBridge(shell: AdbShell, log: Logger): Promise<AdbProbeResult> {
  const { AdbAdapter } = await import('../../protocols/adb/adapter.js')
  const { BalongAtBridge } = await import('./platforms/balong/at-bridge.js')
  const { BalongDevice } = await import('./platforms/balong/device.js')

  const bridgeLog = log.child({ bridge: 'balong' })
  const atBridge = new BalongAtBridge(shell, bridgeLog)
  const device = new BalongDevice(atBridge, bridgeLog)

  const adbAdapter = new AdbAdapter(shell, log.child({ adapter: 'adb' }), {
    atBridge,
    device,
    deviceCapability: {
      priority: 8,
      reason: 'AT commands via internal COM port, no auth required',
    },
  })

  return { adapters: [adbAdapter] }
}

// ── HiLink identification ────────────────────────────────────────────────────

const MODEL_RESOLVE_TIMEOUT_MS = 3_000

/**
 * Lightweight probe: query HiLink devicename for display.
 * Shared by identify() (display) and resolveModelFromHiLink() (model resolution).
 */
async function probeHiLinkDeviceName(url: string): Promise<string | undefined> {
  const { HiLinkHttpClient } = await import('./protocols/hilink/client.js')
  const { parseHiLinkXml } = await import('./protocols/hilink/xml.js')
  const { basicInformationSchema } = await import('./protocols/hilink/schemas.js')

  const client = new HiLinkHttpClient(url, MODEL_RESOLVE_TIMEOUT_MS)
  const xml = await client.get('api/device/basic_information', MODEL_RESOLVE_TIMEOUT_MS)
  const info = parseHiLinkXml(xml, basicInformationSchema)
  return info.devicename
}

/**
 * Query HiLink basic_information to resolve the actual device model.
 *
 * basic_information is unauthenticated -- no login needed.
 * Returns undefined if the query fails or the devicename is unknown.
 * Failure is non-fatal: the modem still works, just without model-specific
 * capability overrides and quirks.
 */
async function resolveModelFromHiLink(
  baseUrl: string,
  log: Logger,
): Promise<ModelInfo | undefined> {
  try {
    const devicename = await probeHiLinkDeviceName(baseUrl)

    if (devicename === undefined) {
      log.info('basic_information has no devicename')
      return undefined
    }

    log.info('HiLink device identified', { devicename })
    const resolved = resolveHiLinkModel(devicename)

    if (resolved !== undefined) {
      log.info('Model resolved', { model: resolved.name })
    } else {
      log.info('Unknown HiLink device', { devicename })
    }

    return resolved
  } catch (err: unknown) {
    // Non-fatal: model resolution is best-effort.
    // The modem works without it, just misses model-specific tweaks.
    log.debug('HiLink model resolution failed', { error: err })
    return undefined
  }
}
