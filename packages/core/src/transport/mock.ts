import { TransportError } from '../errors.js'
import type { Transport } from '../types.js'

/**
 * Mock transport for testing. Simulates modem communication without real hardware.
 *
 * @example
 * ```ts
 * const transport = new MockTransport()
 * await transport.open()
 *
 * // Simulate modem response
 * transport.receive('\r\nOK\r\n')
 *
 * // Auto-respond to commands
 * transport.autoRespond({ 'AT\r': '\r\nOK\r\n' })
 * ```
 */
export class MockTransport implements Transport {
  private _isOpen = false
  private _dataHandler: ((data: Uint8Array) => void) | null = null
  private _disconnectHandler: (() => void) | null = null
  private readonly _written: string[] = []
  private readonly _autoResponses = new Map<string, string>()
  private readonly _encoder = new TextEncoder()
  private readonly _decoder = new TextDecoder()

  get isOpen(): boolean {
    return this._isOpen
  }

  /** All data written to the transport, as strings (for test assertions) */
  get written(): readonly string[] {
    return this._written
  }

  /** The last command written to the transport */
  get lastWritten(): string | undefined {
    return this._written[this._written.length - 1]
  }

  async open(): Promise<void> {
    if (this._isOpen) {
      throw new TransportError('Transport is already open')
    }
    this._isOpen = true
  }

  async close(): Promise<void> {
    if (!this._isOpen) {
      throw new TransportError('Transport is not open')
    }
    this._isOpen = false
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (!this._isOpen) {
      throw new TransportError('Transport is not open')
    }
    const str = typeof data === 'string' ? data : this._decoder.decode(data)
    this._written.push(str)

    // Check for auto-responses
    const response = this._autoResponses.get(str)
    if (response !== undefined) {
      // Deliver asynchronously to simulate real serial behavior
      queueMicrotask(() => {
        this.receive(response)
      })
    }
  }

  onData(handler: (data: Uint8Array) => void): void {
    this._dataHandler = handler
  }

  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler
  }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /** Simulate modem sending data to the host */
  receive(data: string): void {
    this._dataHandler?.(this._encoder.encode(data))
  }

  /** Simulate modem sending data in multiple chunks */
  async receiveChunked(data: string, chunks: number, delayMs = 0): Promise<void> {
    const chunkSize = Math.ceil(data.length / chunks)
    for (let i = 0; i < data.length; i += chunkSize) {
      this.receive(data.slice(i, i + chunkSize))
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }

  /**
   * Register auto-responses: when a specific string is written,
   * the mapped response is automatically sent back.
   *
   * @example
   * ```ts
   * transport.autoRespond({
   *   'AT\r': '\r\nOK\r\n',
   *   'AT+CSQ\r': '\r\n+CSQ: 18,99\r\n\r\nOK\r\n',
   * })
   * ```
   */
  autoRespond(mapping: Record<string, string>): void {
    for (const [command, response] of Object.entries(mapping)) {
      this._autoResponses.set(command, response)
    }
  }

  /** Clear auto-response mappings */
  clearAutoResponses(): void {
    this._autoResponses.clear()
  }

  /** Clear written history */
  clearWritten(): void {
    this._written.length = 0
  }

  /** Clear all test state (written history + auto-responses). */
  resetState(): void {
    this._written.length = 0
    this._autoResponses.clear()
  }

  /** Simulate unexpected disconnect (USB unplug, port gone, etc.) */
  simulateDisconnect(): void {
    this._isOpen = false
    this._disconnectHandler?.()
  }
}
