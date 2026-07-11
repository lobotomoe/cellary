/**
 * Device service for Huawei Balong devices via ADB AT bridge.
 *
 * Uses AT commands through the Balong AT bridge (appvcom1) to read
 * device info, IMEI, and chip temperature. These commands and their
 * response formats are Huawei-specific:
 *   - ATI: Manufacturer/Model/Revision/IMEI (Huawei format)
 *   - AT+CGSN: IMEI (standard 3GPP, but response parsing is device-specific)
 *   - AT^CHIPTEMP?: Huawei proprietary, tenths of degrees Celsius
 */

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Device } from '../../../../protocols/adapter.js'
import type { AdbAtBridge } from '../../../../protocols/adb/types.js'
import type { DeviceInfo } from '../../../../types.js'

export class BalongDevice implements Device {
  private readonly _bridge: AdbAtBridge
  private readonly _log: Logger

  constructor(bridge: AdbAtBridge, logger?: Logger) {
    this._bridge = bridge
    this._log = logger ?? noopLogger
  }

  async info(): Promise<DeviceInfo> {
    this._log.debug('Fetching device info via ATI')
    const raw = await this._bridge.execute('ATI')

    const manufacturer = extractField(raw, 'Manufacturer')
    const model = extractField(raw, 'Model')
    const revision = extractField(raw, 'Revision')
    const imei = extractField(raw, 'IMEI')

    return {
      manufacturer: manufacturer ?? 'Unknown',
      model: model ?? 'Unknown',
      revision: revision ?? 'Unknown',
      imei: imei ?? 'Unknown',
    }
  }

  async imei(): Promise<string> {
    const raw = await this._bridge.execute('AT+CGSN')
    const [firstLine] = raw.split('\n')
    const trimmed = firstLine?.trim() ?? ''
    if (trimmed.length < 14) {
      throw new Error(`Unexpected IMEI response: ${raw}`)
    }
    return trimmed
  }

  async temperature(): Promise<number | undefined> {
    this._log.debug('Reading chip temperature via AT^CHIPTEMP?')
    const raw = await this._bridge.execute('AT^CHIPTEMP?')
    // ^CHIPTEMP: 431,431,65535,35,65535
    // First value is chip temp in tenths of degrees Celsius
    const [, values] = /\^CHIPTEMP:\s*(.+)/.exec(raw) ?? []
    if (values === undefined) return undefined

    const [firstValue] = values.split(',')
    if (firstValue === undefined) return undefined

    const raw10ths = Number(firstValue.trim())
    if (Number.isNaN(raw10ths) || raw10ths === 65535) return undefined

    return raw10ths / 10
  }
}

function extractField(atiOutput: string, field: string): string | undefined {
  const pattern = new RegExp(`^${field}:\\s*(.+)$`, 'm')
  const [, value] = pattern.exec(atiOutput) ?? []
  return value?.trim()
}
