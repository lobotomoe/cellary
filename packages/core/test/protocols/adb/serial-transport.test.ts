import { describe, expect, it, vi } from 'vitest'
import { AdbSerialTransport } from '../../../src/protocols/adb/serial-transport.js'
import type { AdbStream } from '../../../src/protocols/adb/types.js'
import type { AdbConnectionLike } from '../../../src/protocols/adb/wire.js'

// ── Mock helpers ──────────────────────────────────────────────────────────

function createMockStream(): AdbStream & {
  _dataHandler: ((data: Buffer) => void) | undefined
  _closeHandler: (() => void) | undefined
} {
  let dataHandler: ((data: Buffer) => void) | undefined
  let closeHandler: (() => void) | undefined

  return {
    remoteId: 42,
    localId: 1,
    onData(handler) {
      dataHandler = handler
    },
    onClose(handler) {
      closeHandler = handler
    },
    write: vi.fn(async () => {}),
    close: vi.fn(),
    get _dataHandler() {
      return dataHandler
    },
    get _closeHandler() {
      return closeHandler
    },
  }
}

function createMockConnection(stream: AdbStream): AdbConnectionLike {
  return {
    openStream: vi.fn(async () => stream),
    openShell: vi.fn(async () => ''),
    onDisconnect: vi.fn(),
    close: vi.fn(async () => {}),
    isOpen: true,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AdbSerialTransport', () => {
  it('opens a stream with the correct shell command', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)

    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.open()

    expect(connection.openStream).toHaveBeenCalledOnce()
    const destination = vi.mocked(connection.openStream).mock.calls[0]?.[0]
    expect(destination).toContain('appvcom1')
    expect(destination).toContain('shell:')
    expect(transport.isOpen).toBe(true)
  })

  it('forwards data from stream to onData handler', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    const received: Uint8Array[] = []
    transport.onData((data) => received.push(data))

    await transport.open()

    // Simulate modem sending data
    stream._dataHandler?.(Buffer.from('OK\r\n'))

    expect(received).toHaveLength(1)
    const text = new TextDecoder().decode(received[0])
    expect(text).toBe('OK\r\n')
  })

  it('writes data to the stream', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.open()
    await transport.write('AT+CSQ\r')

    expect(stream.write).toHaveBeenCalledOnce()
    const writtenBuf = vi.mocked(stream.write).mock.calls[0]?.[0]
    expect(writtenBuf).toBeDefined()
    expect(writtenBuf?.toString('utf-8')).toBe('AT+CSQ\r')
  })

  it('writes Uint8Array data to the stream', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.open()
    const data = new Uint8Array([0x41, 0x54, 0x0d]) // "AT\r"
    await transport.write(data)

    expect(stream.write).toHaveBeenCalledOnce()
    const writtenBuf = vi.mocked(stream.write).mock.calls[0]?.[0]
    expect(writtenBuf?.toString('utf-8')).toBe('AT\r')
  })

  it('throws on write when not open', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await expect(transport.write('AT\r')).rejects.toThrow('not open')
  })

  it('calls onDisconnect when stream closes', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    const disconnected = vi.fn()
    transport.onDisconnect(disconnected)

    await transport.open()
    expect(transport.isOpen).toBe(true)

    // Simulate stream closing (e.g. ADB connection lost)
    stream._closeHandler?.()

    expect(transport.isOpen).toBe(false)
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it('closes the stream on close()', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.open()
    await transport.close()

    expect(stream.close).toHaveBeenCalledOnce()
    expect(transport.isOpen).toBe(false)
  })

  it('is a no-op to open twice', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.open()
    await transport.open() // second call is no-op

    expect(connection.openStream).toHaveBeenCalledOnce()
  })

  it('is a no-op to close when not open', async () => {
    const stream = createMockStream()
    const connection = createMockConnection(stream)
    const transport = new AdbSerialTransport({
      connection,
      devicePath: '/dev/appvcom1',
    })

    await transport.close() // should not throw
    expect(stream.close).not.toHaveBeenCalled()
  })
})
