import { describe, expect, it, vi } from 'vitest'

import type { System } from '../../../src/protocols/adapter.js'
import { AdbShell } from '../../../src/protocols/adb/shell.js'
import type { AdbAtBridge, ShellResult } from '../../../src/protocols/adb/types.js'
import type { AdbConnectionLike } from '../../../src/protocols/adb/wire.js'

/** A System that exposes the optional IMEI/unlock methods as required. */
interface ImeiSystem extends System {
  writeImei(imei: string): Promise<void>
  readImei(): Promise<string>
  unlock(code: string): Promise<void>
}

function isImeiSystem(system: System | undefined): system is ImeiSystem {
  return (
    system !== undefined &&
    system.writeImei !== undefined &&
    system.readImei !== undefined &&
    system.unlock !== undefined
  )
}

/** Narrow system to expose IMEI/unlock methods, or fail the test. */
function imeiSystem(system: System | undefined): ImeiSystem {
  if (!isImeiSystem(system)) throw new Error('Expected system with IMEI/unlock methods')
  return system
}

// ── TTL parsing tests ───────────────────────────────────────────────────────

describe('TTL parsing from iptables output', () => {
  it('extracts TTL value from standard iptables output', () => {
    const output =
      'Chain POSTROUTING (policy ACCEPT)\n' +
      'target     prot opt source               destination\n' +
      'TTL        all  --  0.0.0.0/0            0.0.0.0/0            TTL set to 64\n'

    const [, ttlStr] = /TTL set to (\d+)/.exec(output) ?? []
    expect(ttlStr).toBeDefined()
    expect(Number(ttlStr)).toBe(64)
  })

  it('returns undefined when no TTL rule exists', () => {
    const output =
      'Chain POSTROUTING (policy ACCEPT)\n' +
      'target     prot opt source               destination\n'

    const match = /TTL set to (\d+)/.exec(output)
    expect(match).toBeNull()
  })

  it('extracts TTL when multiple rules exist', () => {
    const output =
      'Chain POSTROUTING (policy ACCEPT)\n' +
      'target     prot opt source               destination\n' +
      'MASQUERADE all  --  0.0.0.0/0            0.0.0.0/0\n' +
      'TTL        all  --  0.0.0.0/0            0.0.0.0/0            TTL set to 128\n'

    const [, ttlStr] = /TTL set to (\d+)/.exec(output) ?? []
    expect(ttlStr).toBeDefined()
    expect(Number(ttlStr)).toBe(128)
  })
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockShell(responses: Map<string, ShellResult>): AdbShell {
  // A real AdbShell over a stub connection: AdbShell has private fields, so a
  // structural literal can't satisfy it. The adapter never opens a stream in
  // these unit tests (the AT bridge is injected separately), so openStream is a
  // deliberate rejection.
  const connection: AdbConnectionLike = {
    openShell: vi.fn(async () => ''),
    openStream: vi.fn(() => Promise.reject(new Error('openStream not used in adapter unit tests'))),
    onDisconnect: vi.fn(),
    close: vi.fn(async () => {}),
    isOpen: true,
  }
  const shell = new AdbShell(connection)
  const respond = async (cmd: string): Promise<ShellResult> =>
    responses.get(cmd) ?? { stdout: '', exitCode: 0 }
  vi.spyOn(shell, 'exec').mockImplementation(respond)
  vi.spyOn(shell, 'execWithStatus').mockImplementation(respond)
  vi.spyOn(shell, 'ping').mockResolvedValue(true)
  return shell
}

function createMockBridge(responses: Map<string, string>): AdbAtBridge {
  return {
    execute: vi.fn(async (cmd: string): Promise<string> => {
      return responses.get(cmd) ?? ''
    }),
  }
}

// ── AdbAdapter tests ────────────────────────────────────────────────────────

describe('AdbAdapter', () => {
  it('declares system service with priority 10', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    const caps = adapter.serviceCapabilities()
    expect(caps.system).toBeDefined()
    expect(caps.system?.priority).toBe(10)
  })

  it('has kind "adb"', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    expect(adapter.kind).toBe('adb')
  })

  it('init succeeds when ping returns true', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    await expect(adapter.init()).resolves.toBeUndefined()
    expect(shell.ping).toHaveBeenCalled()
  })

  it('init fails when ping returns false', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    vi.mocked(shell.ping).mockResolvedValue(false)
    const adapter = new AdbAdapter(shell)

    await expect(adapter.init()).rejects.toThrow('not responding')
  })

  it('system.shell delegates to AdbShell.exec', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const responses = new Map([['cat /proc/version', { stdout: 'Linux 3.10.0', exitCode: 0 }]])
    const shell = createMockShell(responses)
    const adapter = new AdbAdapter(shell)

    const result = await adapter.system.shell('cat /proc/version')
    expect(result).toBe('Linux 3.10.0')
  })

  it('system.getTtl returns undefined when no rule exists', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const noRules =
      'Chain POSTROUTING (policy ACCEPT)\ntarget     prot opt source               destination\n'
    const responses = new Map([
      ['iptables -t mangle -L POSTROUTING -n', { stdout: noRules, exitCode: 0 }],
    ])
    const shell = createMockShell(responses)
    const adapter = new AdbAdapter(shell)

    const ttl = await adapter.system.getTtl?.()
    expect(ttl).toBeUndefined()
  })

  it('system.getTtl returns value when rule exists', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const withRule =
      'Chain POSTROUTING (policy ACCEPT)\n' +
      'target     prot opt source               destination\n' +
      'TTL        all  --  0.0.0.0/0            0.0.0.0/0            TTL set to 64\n'
    const responses = new Map([
      ['iptables -t mangle -L POSTROUTING -n', { stdout: withRule, exitCode: 0 }],
    ])
    const shell = createMockShell(responses)
    const adapter = new AdbAdapter(shell)

    const ttl = await adapter.system.getTtl?.()
    expect(ttl).toBe(64)
  })

  it('device is undefined when no options provided', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    expect(adapter.device).toBeUndefined()
  })

  it('does not declare device capability without options', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    const caps = adapter.serviceCapabilities()
    expect(caps.device).toBeUndefined()
  })
})

// ── IMEI validation ─────────────────────────────────────────────────────────

describe('IMEI operations', () => {
  it('writeImei throws NotSupportedError when no provider injected', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    await expect(imeiSystem(adapter.system).writeImei('359999990000006')).rejects.toThrow(
      'not available',
    )
  })

  it('readImei throws NotSupportedError when no provider injected', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    await expect(imeiSystem(adapter.system).readImei()).rejects.toThrow('not available')
  })

  it('writeImei delegates to injected provider', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const imeiProvider = {
      writeImei: vi.fn(async () => {}),
      imei: vi.fn(async () => '359999990000006'),
    }
    const adapter = new AdbAdapter(shell, undefined, { imeiProvider })

    await imeiSystem(adapter.system).writeImei('359999990000006')
    expect(imeiProvider.writeImei).toHaveBeenCalledWith('359999990000006')
  })

  it('readImei delegates to injected provider', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const imeiProvider = {
      writeImei: vi.fn(async () => {}),
      imei: vi.fn(async () => '359999990000006'),
    }
    const adapter = new AdbAdapter(shell, undefined, { imeiProvider })

    const result = await imeiSystem(adapter.system).readImei()
    expect(result).toBe('359999990000006')
  })
})

describe('Device unlock', () => {
  it('unlock throws NotSupportedError when no unlocker injected', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    await expect(imeiSystem(adapter.system).unlock('12345678')).rejects.toThrow('not available')
  })

  it('unlock delegates to injected unlocker', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const unlocker = {
      unlock: vi.fn(async () => {}),
      isUnlocked: false,
    }
    const adapter = new AdbAdapter(shell, undefined, { unlocker })

    await imeiSystem(adapter.system).unlock('12345678')
    expect(unlocker.unlock).toHaveBeenCalledWith('12345678')
  })
})

// ── Injected AT bridge ──────────────────────────────────────────────────────

describe('AT bridge injection', () => {
  it('system.executeAt delegates to injected bridge', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const bridge = createMockBridge(new Map([['AT+CGSN', '359999990000006']]))
    const adapter = new AdbAdapter(shell, undefined, { atBridge: bridge })

    const result = await adapter.system.executeAt?.('AT+CGSN')
    expect(result).toBe('359999990000006')
    expect(bridge.execute).toHaveBeenCalledWith('AT+CGSN', undefined)
  })

  it('system.executeAt throws when no bridge injected', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const adapter = new AdbAdapter(shell)

    await expect(adapter.system.executeAt?.('AT')).rejects.toThrow('No AT bridge')
  })
})

// ── Injected device service ─────────────────────────────────────────────────

describe('Device service injection', () => {
  it('exposes injected device service', async () => {
    const { AdbAdapter } = await import('../../../src/protocols/adb/adapter.js')
    const shell = createMockShell(new Map())
    const mockDevice = {
      info: vi.fn(async () => ({
        manufacturer: 'huawei',
        model: 'E8372',
        revision: '1.0',
        imei: '123',
      })),
      imei: vi.fn(async () => '123456789012345'),
    }
    const adapter = new AdbAdapter(shell, undefined, {
      device: mockDevice,
      deviceCapability: { priority: 3, reason: 'test device' },
    })

    expect(adapter.device).toBe(mockDevice)

    const caps = adapter.serviceCapabilities()
    expect(caps.device?.priority).toBe(3)
    expect(caps.device?.reason).toBe('test device')
  })
})
