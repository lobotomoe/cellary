import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATChannel } from '../../../../src/protocols/at/channel/at-channel.js'
import { genericProfile } from '../../../../src/protocols/at/profile.js'
import { SmsModule } from '../../../../src/protocols/at/services/sms/index.js'
import { MockTransport } from '../../../../src/transport/mock.js'

// ─── Test PDU hex strings ───────────────────────────────────────────────────
// Generated with a reference encoder and verified via decodePduDeliver().

// "Hello world" from +1234567890, GSM 7-bit, 24/03/01 12:30:00 TZ+08
const PDU_HELLO = '00000A9121436587090000423010210300800BC8329BFD06DDDF723619'

// "Test msg" from +5551234, GSM 7-bit, 25/01/15 09:00:00 TZ+00
const PDU_TEST_MSG = '00000791551532F400005210519000000008D4F29C0E6ACFCF'

// "Привет" from +79001234567, UCS-2, 24/06/15 10:30:00 TZ+12
const PDU_CYRILLIC = '00000B919700214365F70008426051010300210C041F04400438043204350442'

// Multipart UCS-2: "Part one text here" + " continues", ref=42, from +79001234567
const PDU_MULTI_P1 =
  '00400B919700214365F70008521051900000002A0500032A0201' +
  '00500061007200740020006F006E00650020007400650078007400200068006500720065'
const PDU_MULTI_P2 =
  '00400B919700214365F70008521051900000001A0500032A0202' +
  '00200063006F006E00740069006E007500650073'

// Stored SENT message (SMS-SUBMIT): "Hi" to +1234567890, GSM 7-bit, no timestamp
const PDU_SUBMIT = '0001000A912143658709000002C834'

describe('SmsModule', () => {
  let transport: MockTransport
  let channel: ATChannel
  let sms: SmsModule

  beforeEach(async () => {
    transport = new MockTransport()
    await transport.open()
    channel = new ATChannel(transport, {
      urcPrefixes: genericProfile.urcPrefixes,
      defaultTimeout: 5000,
    })
    sms = new SmsModule(channel, genericProfile)
  })

  afterEach(() => {
    channel.dispose()
  })

  describe('list()', () => {
    it('parses multiple PDU messages', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': [
          '\r\n+CMGL: 0,1,,28\r\n',
          `${PDU_HELLO}\r\n`,
          `+CMGL: 1,0,,24\r\n`,
          `${PDU_TEST_MSG}\r\n`,
          '\r\nOK\r\n',
        ].join(''),
      })

      const messages = await sms.list('all')
      expect(messages).toHaveLength(2)

      // Sorted by timestamp descending: Test msg (2025) before Hello world (2024)
      expect(messages[0]?.index).toBe(1)
      expect(messages[0]?.status).toBe('unread')
      expect(messages[0]?.address).toBe('+5551234')
      expect(messages[0]?.text).toBe('Test msg')

      expect(messages[1]?.index).toBe(0)
      expect(messages[1]?.status).toBe('read')
      expect(messages[1]?.address).toBe('+1234567890')
      expect(messages[1]?.text).toBe('Hello world')
    })

    it('decodes a stored sent message (SMS-SUBMIT) as outgoing without throwing', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': `\r\n+CMGL: 5,3,,14\r\n${PDU_SUBMIT}\r\n\r\nOK\r\n`,
      })

      const messages = await sms.list('all')
      expect(messages).toHaveLength(1)
      expect(messages[0]?.direction).toBe('outgoing')
      expect(messages[0]?.status).toBe('sent')
      expect(messages[0]?.address).toBe('+1234567890') // recipient, not sender
      expect(messages[0]?.text).toBe('Hi')
      expect(messages[0]?.timestamp).toBeUndefined()
    })

    it('lists received messages even when a sent message is also stored', async () => {
      // A stored SMS-SUBMIT must not make the whole listing throw (SMS-C1).
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': [
          '\r\n+CMGL: 0,1,,28\r\n',
          `${PDU_HELLO}\r\n`,
          '+CMGL: 5,3,,14\r\n',
          `${PDU_SUBMIT}\r\n`,
          '\r\nOK\r\n',
        ].join(''),
      })

      const messages = await sms.list('all')
      expect(messages).toHaveLength(2)
      expect(messages.some((m) => m.direction === 'incoming' && m.text === 'Hello world')).toBe(
        true,
      )
      expect(messages.some((m) => m.direction === 'outgoing' && m.text === 'Hi')).toBe(true)
    })

    it('sends correct status code for unread (0)', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=0\r': '\r\nOK\r\n',
      })

      const messages = await sms.list('unread')
      expect(messages).toHaveLength(0)
    })

    it('sends correct status code for sent (3)', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=3\r': '\r\nOK\r\n',
      })

      const messages = await sms.list('sent')
      expect(messages).toHaveLength(0)
    })

    it('returns empty array for no messages', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': '\r\nOK\r\n',
      })

      const messages = await sms.list()
      expect(messages).toHaveLength(0)
    })

    it('decodes UCS-2 PDU message', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': ['\r\n+CMGL: 0,1,,31\r\n', `${PDU_CYRILLIC}\r\n`, '\r\nOK\r\n'].join(''),
      })

      const messages = await sms.list()
      expect(messages[0]?.address).toBe('+79001234567')
      expect(messages[0]?.text).toBe('\u041F\u0440\u0438\u0432\u0435\u0442')
    })

    it('reassembles multipart messages', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': [
          '\r\n+CMGL: 5,1,,65\r\n',
          `${PDU_MULTI_P1}\r\n`,
          `+CMGL: 6,1,,45\r\n`,
          `${PDU_MULTI_P2}\r\n`,
          '\r\nOK\r\n',
        ].join(''),
      })

      const messages = await sms.list()

      // Two PDU segments should become one assembled message
      expect(messages).toHaveLength(1)
      expect(messages[0]?.address).toBe('+79001234567')
      expect(messages[0]?.text).toBe('Part one text here continues')
      // Index of the first received segment
      expect(messages[0]?.index).toBe(5)
    })

    it('reassembles multipart in correct order regardless of arrival order', async () => {
      // Part 2 arrives first (index 3), part 1 arrives second (index 4)
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGL=4\r': [
          '\r\n+CMGL: 3,1,,45\r\n',
          `${PDU_MULTI_P2}\r\n`,
          `+CMGL: 4,1,,65\r\n`,
          `${PDU_MULTI_P1}\r\n`,
          '\r\nOK\r\n',
        ].join(''),
      })

      const messages = await sms.list()
      expect(messages).toHaveLength(1)
      // Text should be in part-number order, not arrival order
      expect(messages[0]?.text).toBe('Part one text here continues')
    })
  })

  describe('read()', () => {
    it('parses a single PDU message', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGR=3\r': ['\r\n+CMGR: 1,,28\r\n', `${PDU_HELLO}\r\n`, '\r\nOK\r\n'].join(''),
      })

      const msg = await sms.read(3)
      expect(msg.index).toBe(3)
      expect(msg.status).toBe('read')
      expect(msg.address).toBe('+1234567890')
      expect(msg.text).toBe('Hello world')
    })

    it('throws for missing SMS', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGR=99\r': '\r\nOK\r\n',
      })

      await expect(sms.read(99)).rejects.toThrow('No SMS at index 99')
    })

    it('parses unread status (0)', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGR=0\r': ['\r\n+CMGR: 0,,24\r\n', `${PDU_TEST_MSG}\r\n`, '\r\nOK\r\n'].join(''),
      })

      const msg = await sms.read(0)
      expect(msg.status).toBe('unread')
      expect(msg.address).toBe('+5551234')
    })

    it('decodes UCS-2 PDU in read', async () => {
      transport.autoRespond({
        'AT+CMGF=0\r': '\r\nOK\r\n',
        'AT+CMGR=5\r': ['\r\n+CMGR: 1,,31\r\n', `${PDU_CYRILLIC}\r\n`, '\r\nOK\r\n'].join(''),
      })

      const msg = await sms.read(5)
      expect(msg.text).toBe('\u041F\u0440\u0438\u0432\u0435\u0442')
    })
  })

  describe('send() adaptive encoding', () => {
    it('uses text mode (CMGF=1) for ASCII text', async () => {
      const promise = sms.send('+1234567890', 'Hello')

      // First: AT+CMGF=1
      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=1\r')
      })
      transport.receive('\r\nOK\r\n')

      // Second: AT+CMGS with quoted number (text mode)
      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGS="+1234567890"\r')
      })
      transport.receive('\r\n> ')

      // Text body sent after prompt
      await vi.waitFor(() => {
        expect(transport.written).toContain('Hello\x1a')
      })
      transport.receive('\r\n+CMGS: 42\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(42)
    })

    it('uses PDU mode (CMGF=0) for Cyrillic text', async () => {
      const text = '\u041F\u0440\u0438\u0432\u0435\u0442'
      const promise = sms.send('+79001234567', text)

      // First: AT+CMGF=0 (PDU mode)
      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=0\r')
      })
      transport.receive('\r\nOK\r\n')

      // Second: AT+CMGS=<length> (PDU length, not quoted number)
      await vi.waitFor(() => {
        const cmgsCommand = transport.written.find((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCommand).toBeDefined()
        // Should be numeric length, not quoted number
        expect(cmgsCommand).toMatch(/^AT\+CMGS=\d+\r$/)
      })
      transport.receive('\r\n> ')

      // PDU hex string sent after prompt
      await vi.waitFor(() => {
        const pduWrite = transport.written.find((w) => w.endsWith('\x1a') && w !== 'Hello\x1a')
        expect(pduWrite).toBeDefined()
        // Should be hex string (uppercase hex chars); find() guaranteed the Ctrl-Z terminator
        expect(pduWrite?.slice(0, -1)).toMatch(/^[0-9A-F]+$/)
      })
      transport.receive('\r\n+CMGS: 7\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(7)
    })

    it('uses PDU mode (CMGF=0) for Armenian text', async () => {
      const promise = sms.send('+37491234567', '\u0532\u0561\u0580\u0565\u0582')

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=0\r')
      })
      transport.receive('\r\nOK\r\n')

      await vi.waitFor(() => {
        const cmgsCommand = transport.written.find((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCommand).toMatch(/^AT\+CMGS=\d+\r$/)
      })
      transport.receive('\r\n> ')

      await vi.waitFor(() => {
        const pduWrite = transport.written.find(
          (w) => w.endsWith('\x1a') && /^[0-9A-F]+$/.test(w.slice(0, -1)),
        )
        expect(pduWrite).toBeDefined()
      })
      transport.receive('\r\n+CMGS: 3\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(3)
    })

    it('uses PDU mode (CMGF=0) for emoji', async () => {
      const promise = sms.send('+1234567890', '\u{1F44D}')

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=0\r')
      })
      transport.receive('\r\nOK\r\n')

      await vi.waitFor(() => {
        const cmgsCommand = transport.written.find((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCommand).toMatch(/^AT\+CMGS=\d+\r$/)
      })
      transport.receive('\r\n> ')

      await vi.waitFor(() => {
        const pduWrite = transport.written.find(
          (w) => w.endsWith('\x1a') && /^[0-9A-F]+$/.test(w.slice(0, -1)),
        )
        expect(pduWrite).toBeDefined()
      })
      transport.receive('\r\n+CMGS: 5\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(5)
    })

    it('uses text mode for 160-char ASCII (max single GSM 7-bit SMS)', async () => {
      const maxText = 'A'.repeat(160)
      const promise = sms.send('+1234567890', maxText)

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=1\r')
      })
      transport.receive('\r\nOK\r\n')

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGS="+1234567890"\r')
      })
      transport.receive('\r\n> ')

      await vi.waitFor(() => {
        expect(transport.written).toContain(`${maxText}\x1a`)
      })
      transport.receive('\r\n+CMGS: 10\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(10)
    })

    it('sends concatenated segments for unicode text > 70 chars', async () => {
      // 71 chars -> 2 segments (67 + 4)
      const longUnicode = '\u0410'.repeat(71)
      const promise = sms.send('+1234567890', longUnicode)

      // AT+CMGF=0
      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=0\r')
      })
      transport.receive('\r\nOK\r\n')

      // First segment: AT+CMGS=<len>
      await vi.waitFor(() => {
        const cmgsCommand = transport.written.find((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCommand).toMatch(/^AT\+CMGS=\d+\r$/)
      })
      transport.receive('\r\n> ')

      // First segment PDU
      await vi.waitFor(() => {
        const pduWrite = transport.written.find(
          (w) => w.endsWith('\x1a') && /^[0-9A-F]+$/.test(w.slice(0, -1)),
        )
        expect(pduWrite).toBeDefined()
      })
      transport.receive('\r\n+CMGS: 50\r\n\r\nOK\r\n')

      // Second segment: AT+CMGS=<len>
      await vi.waitFor(() => {
        const cmgsCmds = transport.written.filter((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCmds).toHaveLength(2)
      })
      transport.receive('\r\n> ')

      // Second segment PDU
      await vi.waitFor(() => {
        const pduWrites = transport.written.filter(
          (w) => w.endsWith('\x1a') && /^[0-9A-F]+$/.test(w.slice(0, -1)),
        )
        expect(pduWrites).toHaveLength(2)
      })
      transport.receive('\r\n+CMGS: 51\r\n\r\nOK\r\n')

      // Returns first segment's reference
      const ref = await promise
      expect(ref).toBe(50)
    })

    it('uses PDU mode for exactly 70 unicode chars', async () => {
      const maxUnicode = '\u0410'.repeat(70)
      const promise = sms.send('+1234567890', maxUnicode)

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=0\r')
      })
      transport.receive('\r\nOK\r\n')

      await vi.waitFor(() => {
        const cmgsCommand = transport.written.find((w) => w.startsWith('AT+CMGS='))
        expect(cmgsCommand).toMatch(/^AT\+CMGS=\d+\r$/)
      })
      transport.receive('\r\n> ')

      await vi.waitFor(() => {
        const pduWrite = transport.written.find(
          (w) => w.endsWith('\x1a') && /^[0-9A-F]+$/.test(w.slice(0, -1)),
        )
        expect(pduWrite).toBeDefined()
      })
      transport.receive('\r\n+CMGS: 20\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(20)
    })

    it('uses text mode for GSM 7-bit special chars', async () => {
      const promise = sms.send('+1234567890', '\u00A3\u00A5')

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGF=1\r')
      })
      transport.receive('\r\nOK\r\n')

      await vi.waitFor(() => {
        expect(transport.written).toContain('AT+CMGS="+1234567890"\r')
      })
      transport.receive('\r\n> ')

      await vi.waitFor(() => {
        expect(transport.written).toContain('\u00A3\u00A5\x1a')
      })
      transport.receive('\r\n+CMGS: 1\r\n\r\nOK\r\n')

      const ref = await promise
      expect(ref).toBe(1)
    })
  })
})
