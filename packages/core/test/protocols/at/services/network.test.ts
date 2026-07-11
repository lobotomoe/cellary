import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { NetworkModule } from '../../../../src/protocols/at/services/network.js'
import { MockTransport } from '../../../../src/transport/mock.js'

describe('NetworkModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let network: NetworkModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: genericProfile.urcPrefixes,
      defaultTimeout: 5000,
    })
    network = new NetworkModule(channel, genericProfile)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('registration()', () => {
    it('parses full CREG response with LAC, Cell ID, and AcT', async () => {
      transport.autoRespond({ 'AT+CREG?\r': '\r\n+CREG: 1,1,"00A1","1A2B3C",7\r\n\r\nOK\r\n' })

      const info = await network.registration()
      expect(info.status).toBe('home')
      expect(info.locationAreaCode).toBe('00A1')
      expect(info.cellId).toBe('1A2B3C')
      expect(info.technology).toBe('LTE')
    })

    it('parses minimal CREG response (status only)', async () => {
      transport.autoRespond({
        'AT+CREG?\r': '\r\n+CREG: 0,2\r\n\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0\r\n\r\nOK\r\n',
      })

      const info = await network.registration()
      expect(info.status).toBe('searching')
      expect(info.locationAreaCode).toBeUndefined()
      expect(info.cellId).toBeUndefined()
      expect(info.technology).toBeUndefined()
    })

    it('maps all status codes correctly', async () => {
      const statusMap: Record<number, string> = {
        0: 'notRegistered',
        1: 'home',
        2: 'searching',
        3: 'denied',
        4: 'unknown',
        5: 'roaming',
      }

      for (const [code, expected] of Object.entries(statusMap)) {
        transport.clearAutoResponses()
        transport.autoRespond({
          'AT+CREG?\r': `\r\n+CREG: 0,${code}\r\n\r\nOK\r\n`,
          'AT+COPS?\r': '\r\n+COPS: 0\r\n\r\nOK\r\n',
        })

        const info = await network.registration()
        expect(info.status).toBe(expected)
      }
    })

    it('maps access technology codes', async () => {
      const techMap: Record<number, string> = {
        0: 'GSM',
        2: '3G',
        3: 'EDGE',
        7: 'LTE',
      }

      for (const [code, expected] of Object.entries(techMap)) {
        transport.clearAutoResponses()
        transport.autoRespond({
          'AT+CREG?\r': `\r\n+CREG: 1,1,"0001","ABCD",${code}\r\n\r\nOK\r\n`,
        })

        const info = await network.registration()
        expect(info.technology).toBe(expected)
      }
    })

    it('falls back to COPS for technology when CREG omits AcT', async () => {
      // E3372 pattern: +CREG has LAC/CellID but no AcT field
      transport.autoRespond({
        'AT+CREG?\r': '\r\n+CREG: 2,5,"003D","00278120"\r\n\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0,0,"UCOM",7\r\n\r\nOK\r\n',
      })

      const info = await network.registration()
      expect(info.status).toBe('roaming')
      expect(info.locationAreaCode).toBe('003D')
      expect(info.cellId).toBe('00278120')
      expect(info.technology).toBe('LTE')
    })

    it('throws ParseError when response has no data', async () => {
      transport.autoRespond({ 'AT+CREG?\r': '\r\nOK\r\n' })

      await expect(network.registration()).rejects.toThrow('AT+CREG? returned no data')
    })

    it('parses CREG with LAC but no Cell ID', async () => {
      transport.autoRespond({
        'AT+CREG?\r': '\r\n+CREG: 1,5,"ABCD"\r\n\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0\r\n\r\nOK\r\n',
      })

      const info = await network.registration()
      expect(info.status).toBe('roaming')
      expect(info.locationAreaCode).toBe('ABCD')
      expect(info.cellId).toBeUndefined()
    })
  })

  describe('operator()', () => {
    it('parses operator name', async () => {
      transport.autoRespond({
        'AT+COPS=3,0\r': '\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0,0,"T-Mobile"\r\n\r\nOK\r\n',
      })

      const name = await network.operator()
      expect(name).toBe('T-Mobile')
    })

    it('returns undefined when not registered', async () => {
      transport.autoRespond({
        'AT+COPS=3,0\r': '\r\nOK\r\n',
        'AT+COPS?\r': '\r\n+COPS: 0\r\n\r\nOK\r\n',
      })

      const name = await network.operator()
      expect(name).toBeUndefined()
    })

    it('throws ParseError when response has no data', async () => {
      transport.autoRespond({
        'AT+COPS=3,0\r': '\r\nOK\r\n',
        'AT+COPS?\r': '\r\nOK\r\n',
      })

      await expect(network.operator()).rejects.toThrow('AT+COPS? returned no data')
    })
  })

  describe('scan()', () => {
    it('parses multiple operators', async () => {
      transport.autoRespond({
        'AT+COPS=?\r':
          '\r\n+COPS: (2,"UCOM","UCOM","28301",7),(1,"Beeline","BL","28310",0),(3,"MTS","MTS","25001",7)\r\n\r\nOK\r\n',
      })

      const networks = await network.scan()
      expect(networks).toHaveLength(3)

      expect(networks[0]).toEqual({
        status: 'current',
        name: 'UCOM',
        shortName: 'UCOM',
        numeric: '28301',
        technology: 'LTE',
      })

      expect(networks[1]).toEqual({
        status: 'available',
        name: 'Beeline',
        shortName: 'BL',
        numeric: '28310',
        technology: 'GSM',
      })

      expect(networks[2]).toEqual({
        status: 'forbidden',
        name: 'MTS',
        shortName: 'MTS',
        numeric: '25001',
        technology: 'LTE',
      })
    })

    it('parses operators without AcT field', async () => {
      transport.autoRespond({
        'AT+COPS=?\r': '\r\n+COPS: (1,"T-Mobile","T-M","310410")\r\n\r\nOK\r\n',
      })

      const networks = await network.scan()
      expect(networks).toHaveLength(1)
      expect(networks[0]?.technology).toBeUndefined()
      expect(networks[0]?.name).toBe('T-Mobile')
      expect(networks[0]?.numeric).toBe('310410')
    })

    it('returns empty array when no operators found', async () => {
      transport.autoRespond({
        'AT+COPS=?\r': '\r\n+COPS: \r\n\r\nOK\r\n',
      })

      const networks = await network.scan()
      expect(networks).toHaveLength(0)
    })

    it('handles unknown status code as unknown', async () => {
      transport.autoRespond({
        'AT+COPS=?\r': '\r\n+COPS: (0,"Unknown Op","UO","99999",2)\r\n\r\nOK\r\n',
      })

      const networks = await network.scan()
      expect(networks).toHaveLength(1)
      expect(networks[0]?.status).toBe('unknown')
      expect(networks[0]?.technology).toBe('3G')
    })

    it('handles response split across multiple lines', async () => {
      transport.autoRespond({
        'AT+COPS=?\r':
          '\r\n+COPS: (2,"Op1","O1","11111",7),\r\n(1,"Op2","O2","22222",0)\r\n\r\nOK\r\n',
      })

      const networks = await network.scan()
      expect(networks).toHaveLength(2)
    })
  })

  describe('selectOperator()', () => {
    it('sends manual selection command', async () => {
      transport.autoRespond({ 'AT+COPS=1,2,"28301"\r': '\r\nOK\r\n' })

      await expect(network.selectOperator('28301')).resolves.toBeUndefined()
    })
  })

  describe('selectAutomatic()', () => {
    it('sends automatic selection command', async () => {
      transport.autoRespond({ 'AT+COPS=0\r': '\r\nOK\r\n' })

      await expect(network.selectAutomatic()).resolves.toBeUndefined()
    })
  })
})
