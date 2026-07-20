/**
 * MSM8916 OEM vendor plugin.
 *
 * Discovers protocol adapters for MSM8916/MDM9207-based 4G USB dongles
 * (TianJie, UFI, UZ801, etc.). These devices expose either:
 *
 * - RNDIS over USB (PID 0xf00e) with HTTP management API at 192.168.100.1
 * - AT serial over USB (PID 0x90b6, interface 2) after USB composition switch
 *
 * For RNDIS mode, creates a MifiAdapter backed by a userspace RNDIS transport.
 * For AT mode, creates a standard AtAdapter. The debug composite (PID 0x90b6)
 * additionally exposes a native ADB interface — an ADB adapter carrying the
 * Thermal service is attached so the preparation pipeline can cap CPU frequency.
 */

import type { AuditSink } from '../../audit.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import type { ProtocolAdapter, VendorPlugin } from '../../protocols/adapter.js'
import { UZ801_PID_MODEM_DIAG_ADB } from './models/index.js'
import { MIFI_PIDS, QUALCOMM_VID } from './usb-ids.js'

/**
 * Open the device's native ADB interface and wrap it in an adapter that exposes
 * the MSM8916 Thermal service (CPU sensors + frequency cap).
 */
async function createAdbThermalAdapter(
  vendorId: number,
  productId: number,
  log: Logger,
  auditSink?: AuditSink,
): Promise<ProtocolAdapter> {
  const { AdbAdapter, connectAdbOverUsb } = await import('../../protocols/adb/index.js')
  const { Msm8916Thermal } = await import('./protocols/adb/thermal.js')

  const shell = await connectAdbOverUsb(
    vendorId,
    productId,
    log.child({ adapter: 'adb' }),
    auditSink,
  )
  const thermal = new Msm8916Thermal(shell, log.child({ service: 'thermal' }))

  return new AdbAdapter(shell, log.child({ adapter: 'adb' }), {
    thermal,
    thermalCapability: { priority: 10, reason: 'CPU sensors + frequency cap via ADB sysfs' },
  })
}

export const msm8916OemPlugin: VendorPlugin = {
  vendorId: 'msm8916-oem',
  name: 'MSM8916 OEM',

  async discoverAdapters(transport, profile, model, opts) {
    const log = opts?.logger ?? noopLogger

    // RNDIS mode: device exposes HTTP management API over USB-backed RNDIS
    if (transport.type === 'http') {
      log.info('Creating MiFi adapter (RNDIS)', { url: transport.url })

      const { MifiClient } = await import('./protocols/mifi/client.js')
      const { MifiAdapter } = await import('./protocols/mifi/adapter.js')

      // Parse host from URL for the optional host override
      let host: string | undefined
      try {
        host = new URL(transport.url).hostname
      } catch {
        // Use default host from RNDIS gateway detection
      }

      const client = new MifiClient({ vendorId: QUALCOMM_VID, productId: MIFI_PIDS.rndis }, host)
      await client.open()

      return { adapters: [new MifiAdapter(client)] }
    }

    // AT mode: standard serial/USB transport
    const { AtAdapter } = await import('../../protocols/at/index.js')
    log.info('Connecting AT adapter', { transport: transport.type })
    const atAdapter = await AtAdapter.connect(transport, profile, opts ?? {}, model)
    const adapters: ProtocolAdapter[] = [atAdapter]

    // The debug composite (PID 0x90b6) also exposes a native ADB interface.
    // ADB is an enhancement (Thermal control): if it can't be opened, keep the
    // AT adapter and let the thermal remediation report the gap downstream.
    if (transport.type === 'usb' && transport.productId === UZ801_PID_MODEM_DIAG_ADB) {
      try {
        adapters.push(
          await createAdbThermalAdapter(
            transport.vendorId,
            transport.productId,
            log,
            opts?.auditSink,
          ),
        )
        log.info('Attached ADB adapter with thermal control')
      } catch (err: unknown) {
        log.warn('ADB adapter unavailable; thermal control disabled', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { adapters }
  },

  preparationProfile(_discovered, model) {
    return model?.prepProfile
  },
}
