import { describe, expect, it, vi } from 'vitest'

import type { AdbAtBridge } from '../../../src/protocols/adb/types.js'

function createMockBridge(responses: Map<string, string>): AdbAtBridge {
  return {
    execute: vi.fn(async (cmd: string): Promise<string> => {
      return responses.get(cmd) ?? ''
    }),
  }
}

describe('BalongDevice', () => {
  it('imei() returns IMEI from AT+CGSN', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const bridge = createMockBridge(new Map([['AT+CGSN', '359999990000006']]))
    const device = new BalongDevice(bridge)

    const imei = await device.imei()
    expect(imei).toBe('359999990000006')
  })

  it('info() parses ATI output', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const atiResponse =
      'Manufacturer: huawei\n' +
      'Model: E8372\n' +
      'Revision: 21.328.03.00.00\n' +
      'IMEI: 359999990000006\n' +
      '+GCAP: +CGSM,+DS,+ES'
    const bridge = createMockBridge(new Map([['ATI', atiResponse]]))
    const device = new BalongDevice(bridge)

    const info = await device.info()
    expect(info.manufacturer).toBe('huawei')
    expect(info.model).toBe('E8372')
    expect(info.revision).toBe('21.328.03.00.00')
    expect(info.imei).toBe('359999990000006')
  })

  it('temperature() parses ^CHIPTEMP', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const bridge = createMockBridge(
      new Map([['AT^CHIPTEMP?', '^CHIPTEMP: 431,431,65535,35,65535']]),
    )
    const device = new BalongDevice(bridge)

    const temp = await device.temperature?.()
    expect(temp).toBe(43.1)
  })

  it('temperature() returns undefined for 65535 (sensor absent)', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const bridge = createMockBridge(
      new Map([['AT^CHIPTEMP?', '^CHIPTEMP: 65535,65535,65535,65535,65535']]),
    )
    const device = new BalongDevice(bridge)

    const temp = await device.temperature?.()
    expect(temp).toBeUndefined()
  })

  it('temperature() returns undefined when no CHIPTEMP in response', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const bridge = createMockBridge(new Map([['AT^CHIPTEMP?', 'ERROR']]))
    const device = new BalongDevice(bridge)

    const temp = await device.temperature?.()
    expect(temp).toBeUndefined()
  })

  it('imei() throws on short response', async () => {
    const { BalongDevice } = await import('../../../src/vendor/huawei/platforms/balong/device.js')
    const bridge = createMockBridge(new Map([['AT+CGSN', '123']]))
    const device = new BalongDevice(bridge)

    await expect(device.imei()).rejects.toThrow('Unexpected IMEI')
  })
})
