import { describe, expect, it, vi } from 'vitest'

import { ChannelUnresponsiveError, TimeoutError } from '../src/errors.js'
import { AtAdapter } from '../src/protocols/at/index.js'
import { MockTransport } from '../src/transport/mock.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Init uses channel's resolveTimeout(), falling back to defaultTimeout
// for commands without a profile entry. No hardcoded override.
const FAST_TIMEOUT = 50

function makeProfile(initCommands: string[]) {
  return {
    name: 'test',
    at: {
      initCommands,
      urcPrefixes: ['+CPIN'],
    },
  }
}

async function createAdapter(initCommands: string[], responses: Record<string, string> = {}) {
  const transport = new MockTransport()
  // Probe always succeeds
  transport.autoRespond({ 'AT\r': '\r\nOK\r\n', ...responses })

  const profile = makeProfile(initCommands)
  const adapter = await AtAdapter.connectWithTransport(transport, profile, {
    defaultTimeout: FAST_TIMEOUT,
  })
  return { adapter, transport }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AtAdapter.init()', () => {
  it('runs all init commands when modem responds', async () => {
    const { adapter, transport } = await createAdapter(['ATE0', 'AT+CMEE=1', 'AT+CMGF=0'], {
      'ATE0\r': '\r\nOK\r\n',
      'AT+CMEE=1\r': '\r\nOK\r\n',
      'AT+CMGF=0\r': '\r\nOK\r\n',
    })

    const onError = vi.fn()
    await adapter.init(onError)

    expect(onError).not.toHaveBeenCalled()
    // All 3 init commands + probe = 4 writes
    expect(transport.written).toHaveLength(4)
  })

  it('reports init command errors via onError callback', async () => {
    const { adapter } = await createAdapter(['ATE0', 'AT+CMEE=1'], {
      'ATE0\r': '\r\nOK\r\n',
      'AT+CMEE=1\r': '\r\n+CME ERROR: 10\r\n',
    })

    const errors: Array<{ step: string; message: string }> = []
    await adapter.init((step, err) => errors.push({ step, message: err.message }))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.step).toBe('AT+CMEE=1')
  })

  it('calls markAbsent on CME ERROR 10 (SIM not inserted)', async () => {
    const { adapter } = await createAdapter(['ATE0', 'AT+CNMI=2,1,0,0,0'], {
      'ATE0\r': '\r\nOK\r\n',
      'AT+CNMI=2,1,0,0,0\r': '\r\n+CME ERROR: 10\r\n',
    })

    await adapter.init()

    // Verify markAbsent was called: sim.info() should return 'absent'
    // without sending AT+CPIN? (no autoRespond for it)
    const simInfo = await adapter.sim.info()
    expect(simInfo.state).toBe('absent')
  })

  it('breaks out of init loop after 3 consecutive timeouts', async () => {
    // 5 init commands, none respond except the first
    const commands = ['ATE0', 'AT+CMEE=1', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0', 'AT+CREG=1']
    const { adapter, transport } = await createAdapter(commands, {
      'ATE0\r': '\r\nOK\r\n',
      // AT+CMEE=1, AT+CMGF=0, AT+CNMI: no response -> timeout
    })

    const errors: string[] = []
    await adapter.init((step) => errors.push(step))

    // ATE0 succeeds (no error), AT+CMEE=1 timeouts (1), AT+CMGF=0 (2), AT+CNMI (3) -> break
    // AT+CREG=1 is never sent
    expect(errors).toHaveLength(3) // 3 timeout errors
    expect(errors).not.toContain('AT+CREG=1')

    // Only probe + ATE0 + 3 timed-out commands = 5 writes (not 6)
    expect(transport.written).toHaveLength(5)
  })

  it('marks SIM absent after consecutive timeout cascade', async () => {
    const commands = ['AT+CMEE=1', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0']
    const { adapter } = await createAdapter(commands)
    // No autoRespond for any init command -> all 3 timeout

    await adapter.init()

    // markAbsent should have been called
    const simInfo = await adapter.sim.info()
    expect(simInfo.state).toBe('absent')
  })

  it('resets consecutive timeout count on successful command', async () => {
    // Pattern: timeout, OK, timeout, timeout, timeout -> breaks at 3 consecutive
    const commands = ['CMD1', 'CMD2', 'CMD3', 'CMD4', 'CMD5', 'CMD6']
    const { adapter, transport } = await createAdapter(commands, {
      // CMD1: no response (timeout 1)
      'CMD2\r': '\r\nOK\r\n', // resets count
      // CMD3: no response (timeout 1)
      // CMD4: no response (timeout 2)
      // CMD5: no response (timeout 3) -> break
      // CMD6: never reached
    })

    const errors: string[] = []
    await adapter.init((step) => errors.push(step))

    // CMD1 (timeout), CMD3 (timeout), CMD4 (timeout), CMD5 (timeout -> break)
    expect(errors).toHaveLength(4)
    expect(errors).not.toContain('CMD6')
    // probe + CMD1 + CMD2 + CMD3 + CMD4 + CMD5 = 6 writes
    expect(transport.written).toHaveLength(6)
  })

  it('marks channel unresponsive after cascade -- service calls fail instantly', async () => {
    const commands = ['AT+CMEE=1', 'AT+CMGF=0', 'AT+CNMI=2,1,0,0,0']
    const { adapter } = await createAdapter(commands)

    await adapter.init()

    // device.imei() should fail immediately with ChannelUnresponsiveError, not wait for timeout
    const start = Date.now()
    await expect(adapter.device.imei()).rejects.toThrow(ChannelUnresponsiveError)
    const elapsed = Date.now() - start

    // Must be near-instant (well under the 50ms FAST_TIMEOUT)
    expect(elapsed).toBeLessThan(30)
  })

  it('leaves channel alive when some commands succeeded before cascade', async () => {
    // Simulates SIM-inserted but radio-not-ready: first commands OK, later ones timeout
    const commands = ['ATE0', 'AT+CMEE=1', 'CMD3', 'CMD4', 'CMD5']
    const { adapter } = await createAdapter(commands, {
      'ATE0\r': '\r\nOK\r\n',
      'AT+CMEE=1\r': '\r\nOK\r\n',
      // CMD3, CMD4, CMD5: no response -> 3 consecutive timeouts -> break
    })

    await adapter.init()

    // Channel should NOT be unresponsive -- some commands succeeded
    // device.imei() should timeout normally, not fail with ChannelUnresponsiveError
    await expect(adapter.device.imei()).rejects.toThrow(TimeoutError)
  })

  it('does not break early on non-timeout errors', async () => {
    const commands = ['CMD1', 'CMD2', 'CMD3', 'CMD4']
    const { adapter, transport } = await createAdapter(commands, {
      'CMD1\r': '\r\nERROR\r\n',
      'CMD2\r': '\r\nERROR\r\n',
      'CMD3\r': '\r\nERROR\r\n',
      'CMD4\r': '\r\nOK\r\n',
    })

    const errors: string[] = []
    await adapter.init((step) => errors.push(step))

    // All 4 commands sent (ERROR resets consecutive timeout counter)
    expect(errors).toHaveLength(3) // CMD1, CMD2, CMD3 error; CMD4 OK
    expect(transport.written).toHaveLength(5) // probe + 4 commands
  })
})
