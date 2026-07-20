export type { AdbAdapterOptions, DeviceUnlocker, ImeiProvider } from './adapter.js'
export { AdbAdapter } from './adapter.js'
export { ADB_DEFAULT_PORT } from './constants.js'
export { AdbSerialTransport, type AdbSerialTransportOptions } from './serial-transport.js'
export { AdbShell } from './shell.js'
export type { AdbAtBridge, AdbMessage, AdbStream, ShellResult } from './types.js'
export { AdbConnection, type AdbConnectionLike } from './wire.js'

import type { AuditSink } from '../../audit.js'
import type { Logger } from '../../logger.js'
import { noopLogger } from '../../logger.js'
import { AdbShell } from './shell.js'
import { openAdbUsbBulkDuplex } from './usb-bulk-duplex.js'
import { AdbConnection } from './wire.js'

export { AdbUsbBulkDuplex, openAdbUsbBulkDuplex } from './usb-bulk-duplex.js'
export type { AdbByteDuplex } from './wire.js'

/**
 * Connect to a device's ADB interface directly over USB bulk endpoints.
 *
 * For devices that expose a native ADB interface but no OS-reachable network
 * (e.g. Qualcomm MSM8916 sticks on macOS, whose RNDIS the OS ignores). Claims
 * the ADB interface via libusb, performs the CNXN handshake, and returns a
 * ready AdbShell. Unlike probeAdb this throws on failure -- the caller opted
 * into USB ADB explicitly.
 *
 * @throws TransportError if the device/interface can't be opened or the handshake fails
 */
export async function connectAdbOverUsb(
  vendorId: number,
  productId: number,
  logger?: Logger,
  auditSink?: AuditSink,
): Promise<AdbShell> {
  const log = logger ?? noopLogger
  const duplex = openAdbUsbBulkDuplex(vendorId, productId)
  const conn = await AdbConnection.fromDuplex(duplex)
  return new AdbShell(conn, log, auditSink)
}

/**
 * Probe for ADB availability at the given host:port.
 *
 * Attempts a TCP connection + CNXN handshake + shell ping.
 * Returns a connected AdbShell if successful, undefined otherwise.
 * Never throws — connection failures are swallowed silently.
 */
export async function probeAdb(
  host: string,
  port: number,
  timeoutMs: number,
  logger?: Logger,
  auditSink?: AuditSink,
): Promise<AdbShell | undefined> {
  const log = logger ?? noopLogger

  try {
    const timeout = new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), timeoutMs),
    )
    const attempt = (async () => {
      const conn = await AdbConnection.connect(host, port)
      const shell = new AdbShell(conn, log, auditSink)
      const alive = await shell.ping()
      if (!alive) {
        await shell.close()
        return undefined
      }
      return shell
    })()

    return await Promise.race([attempt, timeout])
  } catch {
    log.debug('ADB probe failed', { host, port })
    return undefined
  }
}
