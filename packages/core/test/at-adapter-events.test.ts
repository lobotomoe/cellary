import { describe, expect, it, vi } from 'vitest'
import type { VendorEvent } from '../src/protocols/adapter.js'
import { AtAdapter } from '../src/protocols/at/index.js'
import type { URC } from '../src/protocols/at/types.js'
import { MockTransport } from '../src/transport/mock.js'
import type {
  CallEvent,
  IndicatorChangeEvent,
  SimStateEvent,
  SsNotificationEvent,
} from '../src/types.js'

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
      '+CSSI',
      '+CSSU',
      '+CNAP',
      '+CIEV',
    ],
  },
}

async function createAdapter(
  interpreter?: (message: { prefix: string; body: string; raw: string }) => VendorEvent | undefined,
) {
  const transport = new MockTransport()
  transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })

  const adapter = await AtAdapter.connectWithTransport(transport, TEST_PROFILE, {
    messageInterpreter: interpreter,
  })
  return { adapter, transport }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AtAdapter typed events', () => {
  describe('SMS', () => {
    it('emits sms:received on +CMTI with translated storage', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('sms:received', handler)

      transport.receive('\r\n+CMTI: "SM",3\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ storage: 'sim', index: 3 })
    })
  })

  describe('Calls', () => {
    it('emits call:state incoming on RING', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:state', handler)

      transport.receive('\r\nRING\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        state: 'incoming',
        direction: 'incoming',
      })
    })

    it('emits call:state incoming with number on +CLIP after RING', async () => {
      const { adapter, transport } = await createAdapter()
      const calls: CallEvent[] = []
      adapter.on('call:state', (info) => calls.push(info))

      transport.receive('\r\nRING\r\n')
      transport.receive('\r\n+CLIP: "+79990000000",145,,,,0\r\n')

      // First: RING without number, second: +CLIP enriches with number
      expect(calls).toHaveLength(2)
      expect(calls[0]).toEqual({ state: 'incoming', direction: 'incoming' })
      expect(calls[1]).toEqual({
        state: 'incoming',
        direction: 'incoming',
        number: '+79990000000',
      })
    })

    it('emits call:state ended on NO CARRIER with last CLIP number', async () => {
      const { adapter, transport } = await createAdapter()
      const events: CallEvent[] = []
      adapter.on('call:state', (info) => events.push(info))

      transport.receive('\r\nRING\r\n')
      transport.receive('\r\n+CLIP: "+79990000000",145\r\n')
      transport.receive('\r\nNO CARRIER\r\n')

      const ended = events.find((e) => e.state === 'ended')
      expect(ended).toBeDefined()
      expect(ended).toMatchObject({
        state: 'ended',
        direction: 'incoming',
        number: '+79990000000',
        reason: 'hangup',
      })
    })

    it('emits call:state ended with reason busy on BUSY', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:state', handler)

      transport.receive('\r\nBUSY\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        state: 'ended',
        direction: 'outgoing',
        reason: 'busy',
      })
    })

    it('emits call:state ended with reason noAnswer on NO ANSWER', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:state', handler)

      transport.receive('\r\nNO ANSWER\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        state: 'ended',
        direction: 'outgoing',
        reason: 'noAnswer',
      })
    })

    it('emits call:state ended with reason noDialtone on NO DIALTONE', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:state', handler)

      transport.receive('\r\nNO DIALTONE\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        state: 'ended',
        direction: 'outgoing',
        reason: 'noDialtone',
      })
    })
  })

  describe('Network', () => {
    it('emits network:registration on +CREG with full info', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('network:registration', handler)

      transport.receive('\r\n+CREG: 1,"1A2B","3C4D5E6F",7\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        status: 'home',
        locationAreaCode: '1A2B',
        cellId: '3C4D5E6F',
        technology: 'LTE',
      })
    })

    it('emits network:registration with status only', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('network:registration', handler)

      transport.receive('\r\n+CREG: 0\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ status: 'notRegistered' })
    })
  })

  describe('SIM', () => {
    it('emits sim:state on +CPIN: READY', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(info: SimStateEvent) => void>()
      adapter.on('sim:state', handler)

      transport.receive('\r\n+CPIN: READY\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ state: 'ready' })
    })

    it('emits sim:state on +CPIN: SIM PIN', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(info: SimStateEvent) => void>()
      adapter.on('sim:state', handler)

      transport.receive('\r\n+CPIN: SIM PIN\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ state: 'pinRequired' })
    })

    it('emits sim:state with unknown for unrecognised state', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(info: SimStateEvent) => void>()
      adapter.on('sim:state', handler)

      transport.receive('\r\n+CPIN: SOME FUTURE STATE\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ state: 'unknown' })
    })
  })

  describe('raw event', () => {
    it('emits raw for every URC', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(urc: URC) => void>()
      adapter.on('raw', handler)

      transport.receive('\r\nRING\r\n')
      transport.receive('\r\n+CPIN: READY\r\n')

      expect(handler).toHaveBeenCalledTimes(2)
    })
  })

  describe('Supplementary service notifications', () => {
    it('emits call:supplementary on +CSSI (MO forwarding active)', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(event: SsNotificationEvent) => void>()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSI: 0\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        direction: 'outgoing',
        notification: 'forwardingActive',
        callIndex: undefined,
      })
    })

    it('emits call:supplementary on +CSSI with call index', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(event: SsNotificationEvent) => void>()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSI: 3,1\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        direction: 'outgoing',
        notification: 'callIsWaiting',
        callIndex: 1,
      })
    })

    it('ignores +CSSI with unknown code', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSI: 99\r\n')

      expect(handler).not.toHaveBeenCalled()
    })

    it('emits call:supplementary on +CSSU (MT forwarded call)', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(event: SsNotificationEvent) => void>()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSU: 0\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        direction: 'incoming',
        notification: 'forwardedCall',
        callIndex: undefined,
        number: undefined,
      })
    })

    it('emits call:supplementary on +CSSU with index and number', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn<(event: SsNotificationEvent) => void>()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSU: 4,1,"+37499123456"\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        direction: 'incoming',
        notification: 'multipartyEntered',
        callIndex: 1,
        number: '+37499123456',
      })
    })

    it('ignores +CSSU with unknown code', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('call:supplementary', handler)

      transport.receive('\r\n+CSSU: 99\r\n')

      expect(handler).not.toHaveBeenCalled()
    })

    it('maps all MO SS codes correctly', async () => {
      const { adapter, transport } = await createAdapter()
      const events: SsNotificationEvent[] = []
      adapter.on('call:supplementary', (e) => events.push(e))

      const expected: [number, string][] = [
        [0, 'forwardingActive'],
        [1, 'conditionalForwardingActive'],
        [2, 'callForwarded'],
        [3, 'callIsWaiting'],
        [4, 'outgoingBarred'],
        [5, 'incomingBarred'],
        [6, 'clirRejected'],
        [7, 'callDeflected'],
      ]

      for (const [code] of expected) {
        transport.receive(`\r\n+CSSI: ${code}\r\n`)
      }

      expect(events).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(events[i]?.notification).toBe(expected[i]?.[1])
        expect(events[i]?.direction).toBe('outgoing')
      }
    })

    it('maps all MT SS codes correctly', async () => {
      const { adapter, transport } = await createAdapter()
      const events: SsNotificationEvent[] = []
      adapter.on('call:supplementary', (e) => events.push(e))

      const expected: [number, string][] = [
        [0, 'forwardedCall'],
        [2, 'callHeldByRemote'],
        [3, 'callRetrievedByRemote'],
        [4, 'multipartyEntered'],
        [5, 'heldCallReleased'],
        [7, 'callConnecting'],
        [8, 'callConnected'],
        [9, 'deflectedCall'],
        [10, 'additionalForwarded'],
      ]

      for (const [code] of expected) {
        transport.receive(`\r\n+CSSU: ${code}\r\n`)
      }

      expect(events).toHaveLength(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(events[i]?.notification).toBe(expected[i]?.[1])
        expect(events[i]?.direction).toBe('incoming')
      }
    })
  })

  describe('Calling name presentation', () => {
    it('emits call:state with callerName on +CNAP', async () => {
      const { adapter, transport } = await createAdapter()
      const events: CallEvent[] = []
      adapter.on('call:state', (e) => events.push(e))

      transport.receive('\r\nRING\r\n')
      transport.receive('\r\n+CLIP: "+37499123456",145\r\n')
      transport.receive('\r\n+CNAP: "John Smith",0\r\n')

      // RING, +CLIP, +CNAP -> 3 call:state events
      expect(events).toHaveLength(3)
      const cnapEvent = events[2]
      expect(cnapEvent).toMatchObject({
        state: 'incoming',
        direction: 'incoming',
        callerName: 'John Smith',
        number: '+37499123456',
      })
    })

    it('ignores +CNAP with empty name', async () => {
      const { adapter, transport } = await createAdapter()
      const events: CallEvent[] = []
      adapter.on('call:state', (e) => events.push(e))

      transport.receive('\r\nRING\r\n')
      transport.receive('\r\n+CNAP: "",0\r\n')

      // RING fires, but +CNAP with empty name should not
      expect(events).toHaveLength(1)
    })
  })

  describe('Indicator change', () => {
    it('emits indicator:change on +CIEV after indicators are loaded', async () => {
      // To test CIEV, we need the adapter's DeviceModule to have loaded
      // indicator descriptors. We test this by first calling indicators()
      // on the adapter's device service, then receiving a CIEV URC.
      const transport = new MockTransport()
      transport.autoRespond({
        'AT\r': '\r\nOK\r\n',
        'AT+CIND=?\r':
          '\r\n+CIND: ("battchg",(0-5)),("signal",(0-5)),("service",(0-1))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 4,3,1\r\n\r\nOK\r\n',
      })

      const adapter = await AtAdapter.connectWithTransport(transport, TEST_PROFILE)
      const handler = vi.fn<(event: IndicatorChangeEvent) => void>()
      adapter.on('indicator:change', handler)

      // Load indicator descriptors
      if (adapter.device.indicators === undefined) throw new Error('indicators not available')
      await adapter.device.indicators()

      // Now CIEV should be resolvable
      transport.receive('\r\n+CIEV: 2,5\r\n')

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({ name: 'signal', value: 5 })
    })

    it('does not emit indicator:change when descriptors not loaded', async () => {
      const { adapter, transport } = await createAdapter()
      const handler = vi.fn()
      adapter.on('indicator:change', handler)

      // CIEV without prior indicators() call -- name can't be resolved
      transport.receive('\r\n+CIEV: 1,3\r\n')

      expect(handler).not.toHaveBeenCalled()
    })

    it('does not emit indicator:change for out-of-range index', async () => {
      const transport = new MockTransport()
      transport.autoRespond({
        'AT\r': '\r\nOK\r\n',
        'AT+CIND=?\r': '\r\n+CIND: ("signal",(0-5))\r\n\r\nOK\r\n',
        'AT+CIND?\r': '\r\n+CIND: 3\r\n\r\nOK\r\n',
      })

      const adapter = await AtAdapter.connectWithTransport(transport, TEST_PROFILE)
      const handler = vi.fn()
      adapter.on('indicator:change', handler)

      if (adapter.device.indicators === undefined) throw new Error('indicators not available')
      await adapter.device.indicators()

      // Index 5 doesn't exist (only 1 descriptor)
      transport.receive('\r\n+CIEV: 5,3\r\n')

      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('vendor message interpreter injection', () => {
    it('emits typed events from injected interpreter', async () => {
      const interpreter = (msg: { prefix: string; body: string }): VendorEvent | undefined => {
        if (msg.prefix === '^DSCI') {
          return {
            event: 'call:state',
            data: { state: 'incoming', direction: 'incoming', number: '123' },
          }
        }
        if (msg.prefix === '^CEND') {
          return {
            event: 'call:state',
            data: { state: 'ended', direction: 'outgoing', reason: 'hangup' },
          }
        }
        return undefined
      }

      const transport = new MockTransport()
      transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })
      const adapter = await AtAdapter.connectWithTransport(
        transport,
        { name: 'test', at: { initCommands: [], urcPrefixes: ['^DSCI', '^CEND'] } },
        { messageInterpreter: interpreter },
      )

      const handler = vi.fn<(info: CallEvent) => void>()
      adapter.on('call:state', handler)

      transport.receive('\r\n^DSCI: 1,1,4,0,"123",129\r\n')
      transport.receive('\r\n^CEND: 1,0,16\r\n')

      expect(handler).toHaveBeenCalledTimes(2)
      expect(handler).toHaveBeenCalledWith({
        state: 'incoming',
        direction: 'incoming',
        number: '123',
      })
      expect(handler).toHaveBeenCalledWith({
        state: 'ended',
        direction: 'outgoing',
        reason: 'hangup',
      })
    })

    it('does not emit when interpreter returns undefined', async () => {
      const interpreter = (): VendorEvent | undefined => undefined

      const { adapter, transport } = await createAdapter(interpreter)
      const handler = vi.fn()
      adapter.on('call:state', handler)

      // Standard RING still fires via built-in handler (not interpreter)
      transport.receive('\r\nRING\r\n')
      // call:state fires from built-in RING handler, not interpreter
      expect(handler).toHaveBeenCalledOnce()
    })
  })
})
