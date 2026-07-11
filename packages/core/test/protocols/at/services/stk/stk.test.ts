import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StkError } from '../../../../../src/errors.js'
import { ATChannel } from '../../../../../src/protocols/at/channel/at-channel.js'
import { StkModule } from '../../../../../src/protocols/at/services/stk/index.js'
import type {
  StkInkeyPrompt,
  StkInputPrompt,
  StkMenu,
  StkNotification,
  StkText,
} from '../../../../../src/protocols/at/services/stk/types.js'
import { MockTransport } from '../../../../../src/transport/mock.js'
import type { AtConfig } from '../../../../../src/types.js'
import { huaweiStkConfig } from '../../../../../src/vendor/huawei/stk-config.js'

const testProfile: AtConfig = {
  initCommands: [],
  urcPrefixes: ['^STIN'],
  commands: {
    stkEnable: 'AT^STSF=1',
    stkIndication: '^STIN',
    stkGetInfo: 'AT^STGI',
    stkRespond: 'AT^STGR',
  },
  stk: huaweiStkConfig,
}

describe('StkModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let stk: StkModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: testProfile.urcPrefixes,
      defaultTimeout: 5000,
    })
    stk = new StkModule(channel, testProfile)
  })

  afterEach(() => {
    stk.disable()
    channel.dispose()
  })

  describe('enable()', () => {
    it('sends the enable command and starts listening', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })

      await stk.enable()

      expect(stk.enabled).toBe(true)
      expect(transport.written).toContain('AT^STSF=1\r')
    })

    it('is idempotent when already enabled', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })

      await stk.enable()
      await stk.enable()

      // Only sent once
      const enableCount = transport.written.filter((w) => w === 'AT^STSF=1\r').length
      expect(enableCount).toBe(1)
    })

    it('throws StkError when enable command fails', async () => {
      transport.autoRespond({ 'AT^STSF=1\r': '\r\nERROR\r\n' })

      await expect(stk.enable()).rejects.toThrow(StkError)
      expect(stk.enabled).toBe(false)
    })
  })

  describe('disable()', () => {
    it('clears state and stops listening', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      stk.disable()

      expect(stk.enabled).toBe(false)
    })

    it('is safe to call when not enabled', () => {
      expect(() => stk.disable()).not.toThrow()
    })
  })

  // Huawei sequential types: Setup Menu = 11, Display Text = 1,
  // Get Inkey = 2, Get Input = 3, Select Item = 5

  describe('URC handling - menu', () => {
    it('emits menu event on ^STIN:11 with Setup Menu', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r':
          '\r\n^STGI: 11,2,"Main Menu"\r\n^STGI: 1,"Balance"\r\n^STGI: 2,"Services"\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const menuPromise = new Promise<StkMenu>((resolve) => {
        stk.on('menu', resolve)
      })

      // Simulate ^STIN URC
      transport.receive('\r\n^STIN: 11\r\n')

      const menu = await menuPromise

      expect(menu.type).toBe('menu')
      expect(menu.title).toBe('Main Menu')
      expect(menu.items).toEqual([
        { id: 1, label: 'Balance' },
        { id: 2, label: 'Services' },
      ])
    })

    it('caches root menu for direct access', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n^STGI: 11,1,"Root"\r\n^STGI: 1,"Item"\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const menuPromise = new Promise<StkMenu>((resolve) => {
        stk.on('menu', resolve)
      })

      transport.receive('\r\n^STIN: 11\r\n')
      await menuPromise

      expect(stk.menu).toBeDefined()
      expect(stk.menu?.title).toBe('Root')
    })
  })

  describe('URC handling - text', () => {
    it('emits text event on ^STIN:1', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=1\r': '\r\n^STGI: 1,0,"Welcome",0\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const textPromise = new Promise<StkText>((resolve) => {
        stk.on('text', resolve)
      })

      transport.receive('\r\n^STIN: 1\r\n')

      const text = await textPromise

      expect(text.type).toBe('text')
      expect(text.text).toBe('Welcome')
      expect(text.clearMode).toBe(0)
      expect(text.priority).toBe(0)
    })
  })

  describe('URC handling - input', () => {
    it('emits input event on ^STIN:3', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=3\r': '\r\n^STGI: 3,1,10,0,0,"Enter PIN"\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const inputPromise = new Promise<StkInputPrompt>((resolve) => {
        stk.on('input', resolve)
      })

      transport.receive('\r\n^STIN: 3\r\n')

      const input = await inputPromise

      expect(input.type).toBe('input')
      expect(input.prompt).toBe('Enter PIN')
      expect(input.minLength).toBe(1)
      expect(input.maxLength).toBe(10)
    })
  })

  describe('URC handling - inkey', () => {
    it('emits inkey event on ^STIN:2', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=2\r': '\r\n^STGI: 2,2,0,"Confirm?"\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const inkeyPromise = new Promise<StkInkeyPrompt>((resolve) => {
        stk.on('inkey', resolve)
      })

      transport.receive('\r\n^STIN: 2\r\n')

      const inkey = await inkeyPromise

      expect(inkey.type).toBe('inkey')
      expect(inkey.prompt).toBe('Confirm?')
      expect(inkey.mode).toBe(2)
    })
  })

  describe('URC handling - transparent commands', () => {
    it('emits notification on ^STIN:6 (Send SMS)', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const notifPromise = new Promise<StkNotification>((resolve) => {
        stk.on('notification', resolve)
      })

      transport.receive('\r\n^STIN: 6, 0, 0\r\n')

      const notif = await notifPromise

      expect(notif.type).toBe('notification')
      expect(notif.commandType).toBe(6)
      expect(notif.subType).toBe(0)
      expect(notif.qualifier).toBe(0)
    })

    it('emits notification on ^STIN:8 (Send USSD)', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const notifPromise = new Promise<StkNotification>((resolve) => {
        stk.on('notification', resolve)
      })

      transport.receive('\r\n^STIN: 8\r\n')

      const notif = await notifPromise

      expect(notif.type).toBe('notification')
      expect(notif.commandType).toBe(8)
      expect(notif.subType).toBe(0)
      expect(notif.qualifier).toBe(0)
    })

    it('does not try STGI for transparent commands', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const notifPromise = new Promise<StkNotification>((resolve) => {
        stk.on('notification', resolve)
      })

      transport.receive('\r\n^STIN: 6, 0, 0\r\n')
      await notifPromise

      // AT^STGI=6 should NOT have been sent (STGI=11 from enable is expected)
      const stgiWrites = transport.written.filter((w) => w === 'AT^STGI=6\r')
      expect(stgiWrites).toHaveLength(0)
    })
  })

  describe('URC handling - session end', () => {
    it('emits session:end on ^STIN:254', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const endPromise = new Promise<void>((resolve) => {
        stk.on('session:end', resolve)
      })

      transport.receive('\r\n^STIN: 254\r\n')

      await endPromise
      // If we get here, the event was emitted
    })
  })

  describe('URC handling - body parsing', () => {
    it('parses ^STIN body with subtype and qualifier', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const notifPromise = new Promise<StkNotification>((resolve) => {
        stk.on('notification', resolve)
      })

      transport.receive('\r\n^STIN: 9, 1, 2\r\n')

      const notif = await notifPromise

      expect(notif.commandType).toBe(9)
      expect(notif.subType).toBe(1)
      expect(notif.qualifier).toBe(2)
    })
  })

  describe('URC handling - errors', () => {
    it('emits error on invalid indication body', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const errorPromise = new Promise<Error>((resolve) => {
        stk.on('error', resolve)
      })

      transport.receive('\r\n^STIN: GARBAGE\r\n')

      const error = await errorPromise

      expect(error).toBeInstanceOf(StkError)
      expect(error.message).toContain('Invalid STK indication')
    })

    it('emits error when STGI command fails', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=1\r': '\r\nERROR\r\n',
      })

      await stk.enable()

      const errorPromise = new Promise<Error>((resolve) => {
        stk.on('error', resolve)
      })

      transport.receive('\r\n^STIN: 1\r\n')

      const error = await errorPromise

      expect(error).toBeInstanceOf(StkError)
      expect(error.message).toContain('STK get info failed')
    })
  })

  describe('select()', () => {
    it('sends STGR with item ID for Setup Menu', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n^STGI: 11,1,"Menu"\r\n^STGI: 1,"Item"\r\n\r\nOK\r\n',
        'AT^STGR=11,0,1\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const menuPromise = new Promise<StkMenu>((resolve) => {
        stk.on('menu', resolve)
      })

      transport.receive('\r\n^STIN: 11\r\n')
      await menuPromise

      await stk.select(1)

      expect(transport.written).toContain('AT^STGR=11,0,1\r')
    })

    it('sends STGR with item ID for Select Item', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=5\r': '\r\n^STGI: 5,2,"Pick"\r\n^STGI: 1,"A"\r\n^STGI: 2,"B"\r\n\r\nOK\r\n',
        'AT^STGR=5,0,2\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const menuPromise = new Promise<StkMenu>((resolve) => {
        stk.on('menu', resolve)
      })

      transport.receive('\r\n^STIN: 5\r\n')
      await menuPromise

      await stk.select(2)

      expect(transport.written).toContain('AT^STGR=5,0,2\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.select(1)).rejects.toThrow(StkError)
      await expect(stk.select(1)).rejects.toThrow('No pending STK command')
    })

    it('throws StkError when pending command type does not match', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=1\r': '\r\n^STGI: 1,0,"Hello",0\r\n\r\nOK\r\n',
      })

      await stk.enable()

      const textPromise = new Promise<StkText>((resolve) => {
        stk.on('text', resolve)
      })

      transport.receive('\r\n^STIN: 1\r\n')
      await textPromise

      await expect(stk.select(1)).rejects.toThrow(StkError)
      await expect(stk.select(1)).rejects.toThrow('Expected pending command type')
    })
  })

  describe('confirm()', () => {
    it('sends STGR OK for Display Text', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=1\r': '\r\n^STGI: 1,0,"Hello",0\r\n\r\nOK\r\n',
        'AT^STGR=1,0\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const textPromise = new Promise<StkText>((resolve) => {
        stk.on('text', resolve)
      })

      transport.receive('\r\n^STIN: 1\r\n')
      await textPromise

      await stk.confirm()

      expect(transport.written).toContain('AT^STGR=1,0\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.confirm()).rejects.toThrow('No pending STK command')
    })
  })

  describe('input()', () => {
    it('sends STGR with text for Get Input', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=3\r': '\r\n^STGI: 3,1,10,0,0,"Enter PIN"\r\n\r\nOK\r\n',
        'AT^STGR=3,0,"1234"\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const inputPromise = new Promise<StkInputPrompt>((resolve) => {
        stk.on('input', resolve)
      })

      transport.receive('\r\n^STIN: 3\r\n')
      await inputPromise

      await stk.input('1234')

      expect(transport.written).toContain('AT^STGR=3,0,"1234"\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.input('test')).rejects.toThrow('No pending STK command')
    })
  })

  describe('key()', () => {
    it('sends STGR with char for Get Inkey', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=2\r': '\r\n^STGI: 2,0,0,"Press key"\r\n\r\nOK\r\n',
        'AT^STGR=2,0,"5"\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const inkeyPromise = new Promise<StkInkeyPrompt>((resolve) => {
        stk.on('inkey', resolve)
      })

      transport.receive('\r\n^STIN: 2\r\n')
      await inkeyPromise

      await stk.key('5')

      expect(transport.written).toContain('AT^STGR=2,0,"5"\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.key('a')).rejects.toThrow('No pending STK command')
    })
  })

  describe('back()', () => {
    it('sends STGR BACKWARD for pending command', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=5\r': '\r\n^STGI: 5,1,"Pick"\r\n^STGI: 1,"X"\r\n\r\nOK\r\n',
        'AT^STGR=5,1\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const menuPromise = new Promise<StkMenu>((resolve) => {
        stk.on('menu', resolve)
      })

      transport.receive('\r\n^STIN: 5\r\n')
      await menuPromise

      await stk.back()

      expect(transport.written).toContain('AT^STGR=5,1\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.back()).rejects.toThrow('No pending STK command to cancel')
    })
  })

  describe('endSession()', () => {
    it('sends STGR END_SESSION for pending command', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
        'AT^STGI=1\r': '\r\n^STGI: 1,0,"Bye",0\r\n\r\nOK\r\n',
        'AT^STGR=1,3\r': '\r\nOK\r\n',
      })

      await stk.enable()

      const textPromise = new Promise<StkText>((resolve) => {
        stk.on('text', resolve)
      })

      transport.receive('\r\n^STIN: 1\r\n')
      await textPromise

      await stk.endSession()

      expect(transport.written).toContain('AT^STGR=1,3\r')
    })

    it('throws StkError when no pending command', async () => {
      await expect(stk.endSession()).rejects.toThrow('No pending STK command to end session')
    })
  })

  describe('profile commands fallback', () => {
    it('throws StkError when profile.commands is empty', async () => {
      const bareProfile: AtConfig = {
        initCommands: [],
        urcPrefixes: ['^STIN'],
      }

      const bareStkModule = new StkModule(channel, bareProfile)

      await expect(bareStkModule.enable()).rejects.toThrow(StkError)
      await expect(bareStkModule.enable()).rejects.toThrow('STK not configured')
      expect(bareStkModule.enabled).toBe(false)
    })
  })

  describe('not listening after disable', () => {
    it('does not emit events after disable', async () => {
      transport.autoRespond({
        'AT^STSF=1\r': '\r\nOK\r\n',
        'AT^STGI=11\r': '\r\n+CME ERROR: 50\r\n',
      })
      await stk.enable()

      const handler = vi.fn()
      stk.on('menu', handler)

      stk.disable()

      // Simulate URC after disable -- should not trigger handler
      transport.autoRespond({
        'AT^STGI=11\r': '\r\n^STGI: 11,1,"Menu"\r\n^STGI: 1,"Item"\r\n\r\nOK\r\n',
      })
      transport.receive('\r\n^STIN: 11\r\n')

      // Give async processing a chance to fire (it shouldn't)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      expect(handler).not.toHaveBeenCalled()
    })
  })
})
