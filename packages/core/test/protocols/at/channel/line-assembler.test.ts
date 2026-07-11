import { describe, expect, it, vi } from 'vitest'
import { LineAssembler } from '../../../../src/protocols/at/channel/line-assembler.js'

function create() {
  const onLine = vi.fn()
  const onPrompt = vi.fn()
  const assembler = new LineAssembler({ onLine, onPrompt })
  return { assembler, onLine, onPrompt }
}

describe('LineAssembler', () => {
  it('emits a complete line', () => {
    const { assembler, onLine } = create()
    assembler.feed('+CSQ: 18,99\r\n')
    expect(onLine).toHaveBeenCalledWith('+CSQ: 18,99')
  })

  it('emits multiple lines from a single chunk', () => {
    const { assembler, onLine } = create()
    assembler.feed('OK\r\n+CMTI: "SM",3\r\n')
    expect(onLine).toHaveBeenCalledTimes(2)
    expect(onLine).toHaveBeenNthCalledWith(1, 'OK')
    expect(onLine).toHaveBeenNthCalledWith(2, '+CMTI: "SM",3')
  })

  it('handles line split across two chunks', () => {
    const { assembler, onLine } = create()
    assembler.feed('+CSQ: 18')
    expect(onLine).not.toHaveBeenCalled()
    assembler.feed(',99\r\n')
    expect(onLine).toHaveBeenCalledWith('+CSQ: 18,99')
  })

  it('handles CRLF split across chunks', () => {
    const { assembler, onLine } = create()
    assembler.feed('+CSQ: 18,99\r')
    expect(onLine).not.toHaveBeenCalled()
    assembler.feed('\n')
    expect(onLine).toHaveBeenCalledWith('+CSQ: 18,99')
  })

  it('emits empty lines', () => {
    const { assembler, onLine } = create()
    assembler.feed('\r\n\r\n')
    expect(onLine).toHaveBeenCalledTimes(2)
    expect(onLine).toHaveBeenNthCalledWith(1, '')
    expect(onLine).toHaveBeenNthCalledWith(2, '')
  })

  it('detects the > prompt', () => {
    const { assembler, onPrompt } = create()
    assembler.feed('\r\n> ')
    expect(onPrompt).toHaveBeenCalledTimes(1)
  })

  it('detects prompt split across chunks', () => {
    const { assembler, onPrompt } = create()
    assembler.feed('\r\n>')
    expect(onPrompt).not.toHaveBeenCalled()
    assembler.feed(' ')
    expect(onPrompt).toHaveBeenCalledTimes(1)
  })

  it('handles a realistic modem response', () => {
    const { assembler, onLine } = create()
    // Simulate: echo + CRLF + info response + CRLF + OK
    assembler.feed('AT+CSQ\r\r\n+CSQ: 18,99\r\n\r\nOK\r\n')
    expect(onLine).toHaveBeenCalledTimes(4)
    expect(onLine).toHaveBeenNthCalledWith(1, 'AT+CSQ') // trailing \r stripped (PTY compat)
    expect(onLine).toHaveBeenNthCalledWith(2, '+CSQ: 18,99')
    expect(onLine).toHaveBeenNthCalledWith(3, '')
    expect(onLine).toHaveBeenNthCalledWith(4, 'OK')
  })

  it('handles Uint8Array input', () => {
    const { assembler, onLine } = create()
    const encoder = new TextEncoder()
    assembler.feed(encoder.encode('OK\r\n'))
    expect(onLine).toHaveBeenCalledWith('OK')
  })

  it('does not emit prompt without trailing space', () => {
    const { assembler, onPrompt } = create()
    assembler.feed('\r\n>')
    expect(onPrompt).not.toHaveBeenCalled()
  })

  it('reset clears the buffer', () => {
    const { assembler, onLine } = create()
    assembler.feed('+CSQ: 18')
    assembler.reset()
    assembler.feed(',99\r\n')
    // Should only see ",99" not "+CSQ: 18,99" because buffer was reset
    expect(onLine).toHaveBeenCalledWith(',99')
  })

  it('handles many small chunks', () => {
    const { assembler, onLine } = create()
    for (const ch of 'OK\r\n') {
      assembler.feed(ch)
    }
    expect(onLine).toHaveBeenCalledWith('OK')
  })
})
