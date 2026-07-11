import { describe, expect, it, vi } from 'vitest'
import { Modem } from '../src/modem.js'
import { MockTransport } from '../src/transport/mock.js'
import type { CallEvent, SimStateEvent, UnsolicitedMessage } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PROFILE = {
  name: 'test',
  at: {
    initCommands: [],
    urcPrefixes: [
      '+CMTI',
      '+CREG',
      'RING',
      '+CLIP',
      'NO CARRIER',
      'BUSY',
      'NO ANSWER',
      'NO DIALTONE',
      '+CPIN',
    ],
  },
}

async function openMock() {
  const transport = new MockTransport()
  transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })
  const modem = await Modem.open({
    path: '',
    transport,
    profile: TEST_PROFILE,
    reconnect: false,
  })
  return { modem, transport }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Modem event forwarding', () => {
  it('forwards sms:received from adapter with translated storage', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn()
    modem.on('sms:received', handler)

    transport.receive('\r\n+CMTI: "SM",5\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ storage: 'sim', index: 5 })
  })

  it('forwards call:state incoming from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: CallEvent) => void>()
    modem.on('call:state', handler)

    transport.receive('\r\nRING\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ state: 'incoming', direction: 'incoming' })
  })

  it('forwards call:state ended from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: CallEvent) => void>()
    modem.on('call:state', handler)

    transport.receive('\r\nNO CARRIER\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      state: 'ended',
      direction: 'outgoing',
      number: undefined,
      reason: 'hangup',
    })
  })

  it('forwards call:state ended with reason busy from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: CallEvent) => void>()
    modem.on('call:state', handler)

    transport.receive('\r\nBUSY\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      state: 'ended',
      direction: 'outgoing',
      reason: 'busy',
    })
  })

  it('forwards call:state ended with reason noAnswer from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: CallEvent) => void>()
    modem.on('call:state', handler)

    transport.receive('\r\nNO ANSWER\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      state: 'ended',
      direction: 'outgoing',
      reason: 'noAnswer',
    })
  })

  it('forwards call:state ended with reason noDialtone from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: CallEvent) => void>()
    modem.on('call:state', handler)

    transport.receive('\r\nNO DIALTONE\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({
      state: 'ended',
      direction: 'outgoing',
      reason: 'noDialtone',
    })
  })

  it('forwards network:registration from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn()
    modem.on('network:registration', handler)

    transport.receive('\r\n+CREG: 1\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ status: 'home' })
  })

  it('forwards sim:state from adapter', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(info: SimStateEvent) => void>()
    modem.on('sim:state', handler)

    transport.receive('\r\n+CPIN: SIM PUK\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ state: 'pukRequired' })
  })

  it('maps adapter raw event to debug:raw', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn<(msg: UnsolicitedMessage) => void>()
    modem.on('debug:raw', handler)

    transport.receive('\r\nRING\r\n')

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'RING', raw: 'RING' }))
  })

  it('does not emit raw -- only debug:raw', async () => {
    const { modem, transport } = await openMock()
    const handler = vi.fn()
    modem.on('raw' as string, handler)

    transport.receive('\r\nRING\r\n')

    expect(handler).not.toHaveBeenCalled()
  })
})
