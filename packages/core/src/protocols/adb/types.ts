/**
 * ADB wire protocol types.
 *
 * Constants (opcodes, sizes, timeouts) live in constants.ts.
 * Reference: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt
 */

export interface AdbMessage {
  readonly command: number
  readonly arg0: number
  readonly arg1: number
  readonly payload: Buffer
}

/**
 * Persistent bidirectional ADB stream.
 *
 * Unlike `openShell()` (which collects all output and returns a string),
 * an AdbStream delivers data incrementally as WRTE messages arrive.
 * Used for long-running connections (e.g. serial device access via shell).
 *
 * The stream is multiplexed on the same TCP connection as one-shot shell
 * commands -- each gets its own localId in the ADB wire protocol.
 */
export interface AdbStream {
  readonly remoteId: number
  readonly localId: number
  /** Register a handler for incoming data (WRTE payloads). */
  onData(handler: (data: Buffer) => void): void
  /** Register a handler for stream close (CLSE from remote or connection loss). */
  onClose(handler: () => void): void
  /** Write data to the remote end. Sends WRTE and waits for OKAY. */
  write(data: Buffer): Promise<void>
  /** Close the stream (sends CLSE to remote). */
  close(): void
}

export interface ShellResult {
  readonly stdout: string
  readonly exitCode: number | undefined
}

/**
 * AT command bridge for executing AT commands via an internal COM port.
 *
 * Vendor-specific: each device family has its own mechanism for bridging
 * AT commands from the Linux userspace to the modem DSP/RTOS (virtual COM
 * ports, diag channels, etc.). Vendors implement this interface and inject
 * it into AdbAdapter via constructor options.
 */
export interface AdbAtBridge {
  /** Execute an AT command and return the parsed response. */
  execute(command: string, waitMs?: number): Promise<string>
}
