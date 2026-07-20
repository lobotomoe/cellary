import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { DataModule } from '../../../../src/protocols/at/services/data.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const genericAtConfig = requireAtConfig(genericProfile)

describe('DataModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let data: DataModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: genericAtConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    data = new DataModule(channel, genericAtConfig)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('status()', () => {
    it('reports connected when attached and context active', async () => {
      transport.autoRespond({
        'AT+CGATT?\r': '\r\n+CGATT: 1\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\n+CGACT: 1,1\r\n\r\nOK\r\n',
      })

      const status = await data.status()
      expect(status.attached).toBe(true)
      expect(status.state).toBe('connected')
    })

    it('reports disconnected when attached but no active context', async () => {
      transport.autoRespond({
        'AT+CGATT?\r': '\r\n+CGATT: 1\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\n+CGACT: 1,0\r\n\r\nOK\r\n',
      })

      const status = await data.status()
      expect(status.attached).toBe(true)
      expect(status.state).toBe('disconnected')
    })

    it('reports disconnected and detached', async () => {
      transport.autoRespond({
        'AT+CGATT?\r': '\r\n+CGATT: 0\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\nOK\r\n',
      })

      const status = await data.status()
      expect(status.attached).toBe(false)
      expect(status.state).toBe('disconnected')
    })

    it('reports connected if any context is active', async () => {
      transport.autoRespond({
        'AT+CGATT?\r': '\r\n+CGATT: 1\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\n+CGACT: 1,0\r\n+CGACT: 2,1\r\n+CGACT: 3,0\r\n\r\nOK\r\n',
      })

      const status = await data.status()
      expect(status.state).toBe('connected')
    })
  })

  describe('contexts()', () => {
    it('returns empty array when no contexts defined', async () => {
      transport.autoRespond({
        'AT+CGDCONT?\r': '\r\nOK\r\n',
        'AT+CGACT?\r': '\r\nOK\r\n',
        'AT+CGPADDR\r': '\r\nOK\r\n',
      })

      const contexts = await data.contexts()
      expect(contexts).toEqual([])
    })

    it('parses single context with IP address', async () => {
      transport.autoRespond({
        'AT+CGDCONT?\r': '\r\n+CGDCONT: 1,"IP","internet","",0,0\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\n+CGACT: 1,1\r\n\r\nOK\r\n',
        'AT+CGPADDR\r': '\r\n+CGPADDR: 1,"10.20.30.40"\r\n\r\nOK\r\n',
      })

      const contexts = await data.contexts()
      expect(contexts).toHaveLength(1)
      expect(contexts[0]).toEqual({
        cid: 1,
        pdpType: 'IP',
        apn: 'internet',
        active: true,
        address: '10.20.30.40',
      })
    })

    it('parses multiple contexts with mixed states', async () => {
      transport.autoRespond({
        'AT+CGDCONT?\r':
          '\r\n+CGDCONT: 1,"IP","internet","",0,0\r\n' +
          '+CGDCONT: 2,"IPV4V6","ims","",0,0\r\n' +
          '+CGDCONT: 3,"IP","mms","",0,0\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\n+CGACT: 1,1\r\n+CGACT: 2,0\r\n+CGACT: 3,0\r\n\r\nOK\r\n',
        'AT+CGPADDR\r':
          '\r\n+CGPADDR: 1,"10.20.30.40"\r\n' + '+CGPADDR: 2,""\r\n' + '+CGPADDR: 3\r\n\r\nOK\r\n',
      })

      const contexts = await data.contexts()
      expect(contexts).toHaveLength(3)

      expect(contexts[0]).toEqual({
        cid: 1,
        pdpType: 'IP',
        apn: 'internet',
        active: true,
        address: '10.20.30.40',
      })

      expect(contexts[1]).toEqual({
        cid: 2,
        pdpType: 'IPV4V6',
        apn: 'ims',
        active: false,
        address: undefined,
      })

      expect(contexts[2]).toEqual({
        cid: 3,
        pdpType: 'IP',
        apn: 'mms',
        active: false,
        address: undefined,
      })
    })

    it('handles context without CGACT entry (defaults inactive)', async () => {
      transport.autoRespond({
        'AT+CGDCONT?\r': '\r\n+CGDCONT: 5,"IP","test","",0,0\r\n\r\nOK\r\n',
        'AT+CGACT?\r': '\r\nOK\r\n',
        'AT+CGPADDR\r': '\r\nOK\r\n',
      })

      const contexts = await data.contexts()
      expect(contexts).toHaveLength(1)
      expect(contexts[0]?.active).toBe(false)
      expect(contexts[0]?.address).toBeUndefined()
    })
  })
})
