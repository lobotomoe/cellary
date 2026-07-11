const CRLF = '\r\n'
const PROMPT = '> '
const DECODER = new TextDecoder()

/** Callbacks from the line assembler */
export interface LineAssemblerEvents {
  /** A complete \r\n-delimited line (content without the \r\n) */
  onLine(line: string): void
  /** The `> ` prompt was detected (SMS PDU data input mode) */
  onPrompt(): void
}

/**
 * Accumulates raw bytes from a transport and emits complete lines.
 *
 * AT protocol frames responses with \r\n. Data arrives from the serial port
 * in arbitrary chunks — this class reassembles them into complete lines.
 *
 * Also detects the special `> ` prompt used for SMS PDU data entry,
 * which has no trailing \r\n.
 */
export class LineAssembler {
  private buffer = ''

  constructor(private readonly events: LineAssemblerEvents) {}

  /** Feed raw bytes from the transport */
  feed(data: Uint8Array | string): void {
    this.buffer += typeof data === 'string' ? data : DECODER.decode(data)
    this.drain()
  }

  /** Reset internal buffer */
  reset(): void {
    this.buffer = ''
  }

  private drain(): void {
    for (;;) {
      const idx = this.buffer.indexOf(CRLF)
      if (idx === -1) break

      // Strip trailing \r — ADB shell PTY converts \n -> \r\n in output,
      // so modem's \r\n arrives as \r\r\n. After splitting on \r\n, lines
      // have a spurious trailing \r that breaks final-code recognition.
      const raw = this.buffer.slice(0, idx)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      this.buffer = this.buffer.slice(idx + CRLF.length)
      this.events.onLine(line)
    }

    // Check for the `> ` prompt at the end of the buffer.
    // The prompt is `\r\n> ` but the \r\n was already consumed above,
    // so we check if the remaining buffer ends with `> `.
    // We also handle the case where `> ` is the entire buffer
    // (e.g. after all preceding lines were drained).
    if (this.buffer.endsWith(PROMPT)) {
      this.buffer = ''
      this.events.onPrompt()
    }
  }
}
