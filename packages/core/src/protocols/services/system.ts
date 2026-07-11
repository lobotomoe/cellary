/** Bidirectional byte stream for interactive shell sessions. */
export interface InteractiveStream {
  /** Register a handler for incoming data from the device. */
  onData(handler: (data: Buffer) => void): void
  /** Register a handler for stream close. */
  onClose(handler: () => void): void
  /** Write data to the device. */
  write(data: Buffer): Promise<void>
  /** Close the stream. */
  close(): void
}

export interface System {
  /** Execute a shell command on the device OS. Returns stdout. */
  shell(command: string): Promise<string>
  /** Set outgoing packet TTL via iptables mangle table (1-255). */
  setTtl?(ttl: number): Promise<void>
  /** Read the current TTL rule from iptables mangle table. */
  getTtl?(): Promise<number | undefined>
  /**
   * Make the current TTL rule persistent across reboots.
   *
   * Writes the iptables command to the device's init script (e.g. autorun.sh).
   * Requires the filesystem to be remountable as read-write.
   * Call setTtl() first to set the runtime rule, then persistTtl() to save it.
   */
  persistTtl?(): Promise<void>
  /**
   * Execute an AT command via the device's internal COM port.
   *
   * Some devices have an internal path from the Linux userspace to the modem
   * DSP/RTOS (a virtual COM port, a diag channel, etc.). This method uses that
   * path, which may have access to commands blocked on the external AT interface.
   *
   * Not the same as the external AT serial port exposed over USB.
   * Requires a vendor-specific bridge injected into the adapter.
   */
  executeAt?(command: string, waitMs?: number): Promise<string>
  /**
   * Read IMEI from NV storage (direct NV read, bypasses AT+CGSN).
   * Vendor-specific: requires NV access via AT commands or ADB shell.
   */
  readImei?(): Promise<string>
  /**
   * Write IMEI to NV storage. Device reboot typically needed to apply.
   * Vendor-specific: may require unlock() first depending on the device.
   */
  writeImei?(imei: string): Promise<void>
  /**
   * Unlock protected operations with a vendor-specific code.
   * Required before writeImei() on some devices.
   */
  unlock?(code: string): Promise<void>
  /**
   * Open an interactive shell session on the device.
   * Returns a bidirectional stream for piping stdin/stdout.
   * Not available on all devices or through daemon (direct mode only).
   */
  openInteractiveShell?(): Promise<InteractiveStream>
}
