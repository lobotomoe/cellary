/**
 * Huawei device state detection and navigation.
 *
 * Answers two questions:
 * 1. What state is the device in right now?
 * 2. How do I navigate to the desired state?
 *
 * Detection maps USB product IDs to known operational modes.
 * Navigation follows the minimum required transition path.
 */

import { getDeviceList } from 'usb'
import { switchDevice, waitForDevice } from '../../discovery/modeswitch.js'
import { DiscoveryError } from '../../errors.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import { fetchHiLinkSession, requestHiLinkModeSwitch } from './protocols/hilink/index.js'
import type { HiLinkCredentials } from './protocols/hilink/types.js'
import { HUAWEI_VENDOR_SWITCH } from './switch.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** The operational mode a Huawei USB device is currently in. */
export type HuaweiDeviceState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'storage'; readonly pid: number }
  | { readonly kind: 'hilink_only'; readonly pid: number; readonly httpReachable: boolean }
  | { readonly kind: 'hilink_at'; readonly pid: number }

/**
 * USB product ID configuration for a specific Huawei device variant.
 * Describes which PIDs correspond to which operational modes.
 */
export interface HuaweiPidConfig {
  /** USB vendor ID (0x12d1 for all Huawei devices). */
  readonly vendorId: number
  /** PIDs that indicate CD-ROM or mass storage mode. */
  readonly storagePids: readonly number[]
  /** PID for HiLink-only mode (CDC-ECM only, no AT serial interface). */
  readonly hilinkOnlyPid: number
  /** PID for HiLink + AT mode (target operational state). */
  readonly hilinkAtPid: number
  /** Base URL for the HiLink HTTP management API. */
  readonly baseUrl: string
}

export interface NavigateOptions {
  /** Credentials for HiLink HTTP login, if the device requires authentication. */
  readonly credentials?: HiLinkCredentials | undefined
  /** Structured logger for transition progress messages. */
  readonly logger?: Logger | undefined
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect the current operational state of a Huawei USB modem.
 *
 * Scans the USB bus for a device matching the given PID configuration.
 * For HiLink-only devices, also probes the HTTP API to determine whether
 * the management interface is currently reachable.
 */
export async function detectHuaweiState(config: HuaweiPidConfig): Promise<HuaweiDeviceState> {
  const devices = getDeviceList()

  for (const dev of devices) {
    const { idVendor, idProduct } = dev.deviceDescriptor
    if (idVendor !== config.vendorId) continue

    if (config.storagePids.includes(idProduct)) {
      return { kind: 'storage', pid: idProduct }
    }

    if (idProduct === config.hilinkOnlyPid) {
      const httpReachable = await probeHiLinkHttp(config.baseUrl)
      return { kind: 'hilink_only', pid: idProduct, httpReachable }
    }

    if (idProduct === config.hilinkAtPid) {
      return { kind: 'hilink_at', pid: idProduct }
    }
  }

  return { kind: 'absent' }
}

/**
 * Navigate the device from its current state to hilink_at mode.
 *
 * Transition paths:
 * - hilink_at  → no-op (already there)
 * - storage    → vendor control transfer → hilink_at
 * - hilink_only + HTTP reachable → CGI switch → storage → vendor control → hilink_at
 * - hilink_only + HTTP unreachable → throws (physical intervention required)
 * - absent → throws
 *
 * On E8372H-153 fw 21.328.03.00.00, the vendor control transfer from storage
 * results in hilink_at only if AT^U2DIAG=256 is stored. If AT^U2DIAG=0 is
 * stored, the device re-enumerates as hilink_only and an error is thrown.
 *
 * @throws {DiscoveryError} If navigation is impossible or the device does not
 *   respond within the expected timeout.
 */
export async function navigateToAtMode(
  config: HuaweiPidConfig,
  opts?: NavigateOptions,
): Promise<void> {
  const log = opts?.logger ?? noopLogger
  const state = await detectHuaweiState(config)
  log.info(`Current state: ${describeState(state)}`)

  switch (state.kind) {
    case 'absent':
      throw new DiscoveryError('No Huawei device found. Ensure it is plugged in.')

    case 'hilink_at':
      log.info('Already in AT mode')
      return

    case 'storage':
      await navigateFromStorage(config, state.pid, log)
      return

    case 'hilink_only':
      if (!state.httpReachable) {
        throw new DiscoveryError(
          `Device is in HiLink-only mode (PID 0x${state.pid.toString(16)}) ` +
            `but the HTTP API at ${config.baseUrl} is unreachable. ` +
            `Cannot switch to AT mode without network access. ` +
            `Ensure the host network interface for ${config.baseUrl} is up.`,
        )
      }
      await navigateFromHilinkOnly(config, opts?.credentials, log)
      return
  }
}

// ── Transition handlers ───────────────────────────────────────────────────────

async function navigateFromStorage(
  config: HuaweiPidConfig,
  currentPid: number,
  log: Logger,
): Promise<void> {
  log.info('Sending vendor control transfer', {
    from: 'storage',
    pid: `0x${currentPid.toString(16)}`,
  })

  // After vendor control, device may land on hilinkAtPid or hilinkOnlyPid depending on NVM.
  const watchPids = new Set([config.hilinkAtPid, config.hilinkOnlyPid])
  const result = await switchDevice(config.vendorId, currentPid, HUAWEI_VENDOR_SWITCH, (pid) =>
    watchPids.has(pid),
  )

  if (!result.switched || result.newProductId === undefined) {
    throw new DiscoveryError(
      'Vendor control transfer sent but device did not re-enumerate within the timeout. ' +
        'Try unplugging and replugging the device.',
    )
  }

  if (result.newProductId === config.hilinkAtPid) {
    log.info('Device is now in AT mode', { pid: `0x${result.newProductId.toString(16)}` })
    return
  }

  if (result.newProductId === config.hilinkOnlyPid) {
    throw new DiscoveryError(
      `Device re-enumerated as HiLink-only (PID 0x${result.newProductId.toString(16)}) ` +
        `after vendor control transfer. ` +
        `The stored AT^U2DIAG value is likely 0. ` +
        `To re-enable AT mode: access the HiLink interface at ${config.baseUrl}, ` +
        `open an AT terminal, and run AT^U2DIAG=256 followed by AT^RESET.`,
    )
  }

  throw new DiscoveryError(
    `Unexpected PID 0x${result.newProductId.toString(16)} after vendor control transfer.`,
  )
}

async function navigateFromHilinkOnly(
  config: HuaweiPidConfig,
  credentials: HiLinkCredentials | undefined,
  log: Logger,
): Promise<void> {
  log.info('Requesting mode switch via HiLink HTTP API', { baseUrl: config.baseUrl })

  await requestHiLinkModeSwitch(config.baseUrl, credentials)

  // requestHiLinkModeSwitch may produce storage or hilink_at directly, depending
  // on firmware. On E8372H-153 fw 21.328.03.00.00, CGI switchMode is the fallback
  // and produces storage (0x1442). On some firmware versions /api/device/mode works
  // and produces hilink_at (0x1566) directly.
  const watchPids = new Set([...config.storagePids, config.hilinkAtPid])
  log.info('Waiting for device to re-enumerate')

  const newPid = await waitForDevice(config.vendorId, (pid) => watchPids.has(pid))

  if (newPid === undefined) {
    throw new DiscoveryError(
      'HiLink mode switch was requested but device did not re-enumerate within the timeout. ' +
        'Try unplugging and replugging the device.',
    )
  }

  if (newPid === config.hilinkAtPid) {
    log.info('Device is now in AT mode', { pid: `0x${newPid.toString(16)}` })
    return
  }

  // Device landed in storage mode — complete the transition via vendor control.
  log.info('Device in storage mode, completing via vendor control', {
    pid: `0x${newPid.toString(16)}`,
  })
  await navigateFromStorage(config, newPid, log)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function probeHiLinkHttp(baseUrl: string): Promise<boolean> {
  try {
    await fetchHiLinkSession(baseUrl)
    return true
  } catch {
    return false
  }
}

function describeState(state: HuaweiDeviceState): string {
  switch (state.kind) {
    case 'absent':
      return 'absent (no device found)'
    case 'storage':
      return `storage (PID 0x${state.pid.toString(16)})`
    case 'hilink_only':
      return `hilink_only (PID 0x${state.pid.toString(16)}, HTTP ${state.httpReachable ? 'reachable' : 'unreachable'})`
    case 'hilink_at':
      return `hilink_at (PID 0x${state.pid.toString(16)})`
  }
}
