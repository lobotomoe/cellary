import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { requireAtConfig } from '../../../../src/protocols/at/index.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { PhonebookModule } from '../../../../src/protocols/at/services/phonebook.js'
import { MockTransport } from '../../../../src/transport/mock.js'

const atConfig = requireAtConfig(genericProfile)

describe('PhonebookModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let phonebook: PhonebookModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: atConfig.urcPrefixes,
      defaultTimeout: 5000,
    })
    phonebook = new PhonebookModule(channel)
  })

  afterEach(() => {
    channel.dispose()
  })

  // ── selectStorage() ──────────────────────────────────────────────────

  describe('selectStorage()', () => {
    it('selects SIM storage and returns info', async () => {
      transport.autoRespond({
        'AT+CPBS="SM"\r': '\r\nOK\r\n',
        'AT+CPBS?\r': '\r\n+CPBS: "SM",5,250\r\n\r\nOK\r\n',
      })

      const info = await phonebook.selectStorage('sim')
      expect(info.storage).toBe('sim')
      expect(info.used).toBe(5)
      expect(info.total).toBe(250)
    })

    it('selects device memory storage', async () => {
      transport.autoRespond({
        'AT+CPBS="ME"\r': '\r\nOK\r\n',
        'AT+CPBS?\r': '\r\n+CPBS: "ME",120,500\r\n\r\nOK\r\n',
      })

      const info = await phonebook.selectStorage('device')
      expect(info.storage).toBe('device')
      expect(info.used).toBe(120)
      expect(info.total).toBe(500)
    })

    it('throws ParseError on empty response', async () => {
      transport.autoRespond({
        'AT+CPBS="SM"\r': '\r\nOK\r\n',
        'AT+CPBS?\r': '\r\nOK\r\n',
      })

      await expect(phonebook.selectStorage('sim')).rejects.toThrow('returned no data')
    })

    it('throws ParseError on malformed response', async () => {
      transport.autoRespond({
        'AT+CPBS="SM"\r': '\r\nOK\r\n',
        'AT+CPBS?\r': '\r\nGARBAGE\r\n\r\nOK\r\n',
      })

      await expect(phonebook.selectStorage('sim')).rejects.toThrow('Failed to parse')
    })
  })

  // ── read() ───────────────────────────────────────────────────────────

  describe('read()', () => {
    it('reads multiple entries', async () => {
      transport.autoRespond({
        'AT+CPBR=1,3\r':
          '\r\n+CPBR: 1,"+37494123456",145,"Alice"\r\n' +
          '+CPBR: 3,"+37491654321",145,"Bob"\r\n\r\nOK\r\n',
      })

      const entries = await phonebook.read(1, 3)
      expect(entries).toHaveLength(2) // index 2 is empty, skipped
      const [first, second] = entries
      if (first === undefined || second === undefined) throw new Error('expected two entries')
      expect(first.index).toBe(1)
      expect(first.number).toBe('+37494123456')
      expect(first.format).toBe('international')
      expect(first.name).toBe('Alice')
      expect(second.index).toBe(3)
      expect(second.name).toBe('Bob')
    })

    it('returns empty array when no entries', async () => {
      transport.autoRespond({
        'AT+CPBR=1,10\r': '\r\nOK\r\n',
      })

      const entries = await phonebook.read(1, 10)
      expect(entries).toHaveLength(0)
    })

    it('parses national number format', async () => {
      transport.autoRespond({
        'AT+CPBR=5,5\r': '\r\n+CPBR: 5,"094123456",129,"Charlie"\r\n\r\nOK\r\n',
      })

      const entries = await phonebook.read(5, 5)
      expect(entries).toHaveLength(1)
      const [entry] = entries
      if (entry === undefined) throw new Error('expected one entry')
      expect(entry.number).toBe('094123456')
      expect(entry.format).toBe('national')
    })
  })

  // ── find() ───────────────────────────────────────────────────────────

  describe('find()', () => {
    it('finds entries by name', async () => {
      transport.autoRespond({
        'AT+CPBF="Ali"\r':
          '\r\n+CPBF: 1,"+37494123456",145,"Alice"\r\n' +
          '+CPBF: 7,"+37493111222",145,"Alina"\r\n\r\nOK\r\n',
      })

      const entries = await phonebook.find('Ali')
      expect(entries).toHaveLength(2)
      const [first, second] = entries
      if (first === undefined || second === undefined) throw new Error('expected two entries')
      expect(first.name).toBe('Alice')
      expect(second.name).toBe('Alina')
    })

    it('returns empty array when no match', async () => {
      transport.autoRespond({
        'AT+CPBF="ZZZ"\r': '\r\nOK\r\n',
      })

      const entries = await phonebook.find('ZZZ')
      expect(entries).toHaveLength(0)
    })
  })

  // ── write() ──────────────────────────────────────────────────────────

  describe('write()', () => {
    it('writes an entry with international number (auto-detected)', async () => {
      transport.autoRespond({
        'AT+CPBW=1,"+37494123456",145,"Alice"\r': '\r\nOK\r\n',
      })

      await phonebook.write(1, '+37494123456', 'Alice')
    })

    it('writes an entry with national number (auto-detected)', async () => {
      transport.autoRespond({
        'AT+CPBW=5,"094123456",129,"Bob"\r': '\r\nOK\r\n',
      })

      await phonebook.write(5, '094123456', 'Bob')
    })
  })

  describe('delete()', () => {
    it('deletes an entry by index', async () => {
      transport.autoRespond({
        'AT+CPBW=3\r': '\r\nOK\r\n',
      })

      await phonebook.delete(3)
    })
  })
})
