/**
 * Huawei lifecycle definition.
 *
 * Two exports:
 *
 * 1. `huaweiLifecycle` -- static definition with logging-only stub actions.
 *    Used for testing, graph inspection, and offline planning.
 *
 * 2. `createHuaweiLifecycle()` -- factory that builds a LifecycleDefinition
 *    with real USB/HTTP transition actions. Closures capture device-specific
 *    config (switch method, HiLink URL/credentials, AT channel ref).
 *
 * Usage (real device):
 *   const def = createHuaweiLifecycle({
 *     switchMethod: HUAWEI_VENDOR_SWITCH,
 *     isModemProduct: (pid) => isModemProduct(entry, pid),
 *   })
 *   const lifecycle = new DeviceLifecycle(def, probeFactory)
 *   await lifecycle.navigateTo('hilink_at')
 */

import type { SwitchMethod } from '../../discovery/modeswitch.js'
import { switchDevice, waitForDevice } from '../../discovery/modeswitch.js'
import { DiscoveryError } from '../../errors.js'
import { GENERIC_DETECTORS } from '../../lifecycle/generic-detectors.js'
import { GENERIC_LAYER } from '../../lifecycle/generic-states.js'
import type {
  LifecycleDefinition,
  TransitionAction,
  TransitionContext,
} from '../../lifecycle/types.js'
import { HUAWEI_LAYER } from './lifecycle.js'
import { HUAWEI_DETECTORS } from './lifecycle-detectors.js'
import { BALONG_LAYER } from './platforms/balong/lifecycle.js'
import { QUALCOMM_LAYER } from './platforms/qualcomm/lifecycle.js'
import { requestHiLinkModeSwitch } from './protocols/hilink/mode-switch.js'
import type { HiLinkCredentials } from './protocols/hilink/types.js'

// -- Factory options ----------------------------------------------------------

export interface HuaweiLifecycleOptions {
  /** USB mode switch method (vendor control or SCSI CBW). */
  readonly switchMethod: SwitchMethod
  /**
   * Predicate: is this PID a recognized modem-mode product?
   * Used to poll for re-enumeration after USB mode switch.
   */
  readonly isModemProduct: (productId: number) => boolean
  /** HiLink HTTP credentials (needed for hilink_only -> storage on password-protected devices). */
  readonly hilinkCredentials?: HiLinkCredentials | undefined
  /** HiLink base URL override. Default: http://192.168.8.1 */
  readonly hilinkBaseUrl?: string | undefined
}

// -- Stub actions (for testing / offline planning) ----------------------------

function createStubAction(edgeKey: string, description: string): TransitionAction {
  return {
    edgeKey,
    async execute(ctx: TransitionContext): Promise<void> {
      ctx.logger.info(`[stub] ${description}`, {
        vendorId: `0x${ctx.vendorId.toString(16)}`,
        productId: `0x${ctx.productId.toString(16)}`,
      })
    },
  }
}

const STUB_ACTIONS: readonly TransitionAction[] = [
  createStubAction('storage->hilink_at', 'USB vendor control: storage -> hilink_at'),
  createStubAction('storage->stick', 'USB vendor control: storage -> stick'),
  createStubAction('storage->modem', 'Generic mode switch: storage -> modem'),
  createStubAction('hilink_only->storage', 'HiLink HTTP switchMode: hilink_only -> storage'),
  createStubAction('hilink_at->balong_download', 'AT^GODLOAD: enter download mode'),
  createStubAction('stick->balong_download', 'AT^GODLOAD: enter download mode'),
  createStubAction('balong_download->storage', 'HDLC reboot: download -> storage'),
]

// -- Real actions (factory-created with device-specific closures) -------------

const DEFAULT_HILINK_URL = 'http://192.168.8.1'

/**
 * storage -> hilink_at / stick / modem: USB vendor control transfer.
 *
 * Opens the USB device by VID/PID, sends the switch command, and polls
 * the bus until a recognized modem-mode PID appears.
 */
function createUsbSwitchAction(edgeKey: string, opts: HuaweiLifecycleOptions): TransitionAction {
  return {
    edgeKey,
    async execute(ctx: TransitionContext): Promise<void> {
      ctx.logger.info(`USB mode switch: ${edgeKey}`, {
        vendorId: `0x${ctx.vendorId.toString(16)}`,
        productId: `0x${ctx.productId.toString(16)}`,
      })

      const result = await switchDevice(
        ctx.vendorId,
        ctx.productId,
        opts.switchMethod,
        opts.isModemProduct,
      )

      if (!result.switched) {
        throw new DiscoveryError(
          `USB mode switch (${edgeKey}) completed but device did not re-enumerate. ` +
            'Try unplugging, waiting a few seconds, and plugging back in.',
        )
      }

      ctx.logger.info('Mode switch successful', {
        newProductId:
          result.newProductId !== undefined ? `0x${result.newProductId.toString(16)}` : 'unknown',
      })
    },
  }
}

/**
 * hilink_only -> storage: HiLink HTTP mode switch request.
 *
 * Tells the device to leave HiLink-only mode via the REST API.
 * The device re-enumerates as a storage PID; the navigator will
 * then plan storage -> target as the next step.
 */
function createHilinkToStorageAction(opts: HuaweiLifecycleOptions): TransitionAction {
  const baseUrl = opts.hilinkBaseUrl ?? DEFAULT_HILINK_URL

  return {
    edgeKey: 'hilink_only->storage',
    async execute(ctx: TransitionContext): Promise<void> {
      ctx.logger.info('HiLink HTTP switchMode: hilink_only -> storage', {
        baseUrl,
        vendorId: `0x${ctx.vendorId.toString(16)}`,
      })

      await requestHiLinkModeSwitch(baseUrl, opts.hilinkCredentials)

      // Wait for device to re-enumerate with a recognized PID
      const newPid = await waitForDevice(ctx.vendorId, opts.isModemProduct)
      if (newPid === undefined) {
        throw new DiscoveryError(
          `HiLink mode switch was sent to ${baseUrl} but device did not re-enumerate. ` +
            'The device may need a manual power cycle.',
        )
      }

      ctx.logger.info('HiLink mode switch successful', {
        newProductId: `0x${newPid.toString(16)}`,
      })
    },
  }
}

/**
 * hilink_at / stick -> balong_download: AT^GODLOAD command.
 *
 * Requires an AT serial channel. Currently a stub -- real implementation
 * needs the AT channel reference, which will be provided when the lifecycle
 * is integrated with the Modem class.
 */
function createAtGodloadAction(edgeKey: string): TransitionAction {
  return {
    edgeKey,
    async execute(ctx: TransitionContext): Promise<void> {
      ctx.logger.info(`AT^GODLOAD: ${edgeKey}`, {
        vendorId: `0x${ctx.vendorId.toString(16)}`,
      })
      // TODO: wire AT channel -- send AT^GODLOAD, await device disconnect
      // Deferred until lifecycle is integrated with Modem/ATChannel
      throw new DiscoveryError(
        `AT^GODLOAD transition (${edgeKey}) requires an AT serial channel. ` +
          'Not yet wired -- use the flash tooling directly for download mode.',
      )
    },
  }
}

/**
 * balong_download -> storage: HDLC reboot command.
 *
 * Requires the HDLC protocol channel. Currently a stub.
 */
function createHdlcRebootAction(): TransitionAction {
  return {
    edgeKey: 'balong_download->storage',
    async execute(ctx: TransitionContext): Promise<void> {
      ctx.logger.info('HDLC reboot: balong_download -> storage', {
        vendorId: `0x${ctx.vendorId.toString(16)}`,
      })
      // TODO: wire HDLC channel -- send reboot command (0x0A)
      throw new DiscoveryError(
        'HDLC reboot transition requires the HDLC protocol channel. ' +
          'Not yet wired -- use the flash tooling directly.',
      )
    },
  }
}

// -- Public API ---------------------------------------------------------------

/**
 * Static Huawei lifecycle definition with logging-only stub actions.
 *
 * Use for testing, graph inspection, and offline planning.
 * For real device transitions, use createHuaweiLifecycle().
 */
export const huaweiLifecycle: LifecycleDefinition = {
  layers: [GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, QUALCOMM_LAYER],
  detectors: [...GENERIC_DETECTORS, ...HUAWEI_DETECTORS],
  actions: STUB_ACTIONS,
}

/**
 * Create a Huawei lifecycle definition with real transition actions.
 *
 * The factory captures device-specific config (switch method, HiLink
 * credentials) in action closures. The resulting definition can be
 * passed to DeviceLifecycle for live device management.
 *
 * USB mode switch actions (storage -> hilink_at/stick/modem) are fully
 * wired. AT^GODLOAD and HDLC reboot are explicit stubs that throw with
 * clear error messages until the AT/HDLC channels are integrated.
 */
export function createHuaweiLifecycle(opts: HuaweiLifecycleOptions): LifecycleDefinition {
  const actions: TransitionAction[] = [
    createUsbSwitchAction('storage->hilink_at', opts),
    createUsbSwitchAction('storage->stick', opts),
    createUsbSwitchAction('storage->modem', opts),
    createHilinkToStorageAction(opts),
    createAtGodloadAction('hilink_at->balong_download'),
    createAtGodloadAction('stick->balong_download'),
    createHdlcRebootAction(),
  ]

  return {
    layers: [GENERIC_LAYER, HUAWEI_LAYER, BALONG_LAYER, QUALCOMM_LAYER],
    detectors: [...GENERIC_DETECTORS, ...HUAWEI_DETECTORS],
    actions,
  }
}
