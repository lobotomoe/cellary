/**
 * Shared interface for userspace USB networking transports.
 *
 * Both RndisTransport and EcmTransport implement this interface,
 * allowing the HTTP client and vendor code to work with either
 * transport type without knowing which USB protocol is in use.
 */
import type { TcpConnection } from 'tcpip'

export interface UsbNetTransport {
  /** Whether the transport is currently open and connected */
  readonly isOpen: boolean
  /** Gateway IP address (the device's IP on the USB link) */
  readonly gatewayIp: string
  /** USB vendor ID of the underlying device */
  readonly vendorId: number
  /** USB product ID of the underlying device */
  readonly productId: number

  /** Open the USB device and initialize the network stack */
  open(): Promise<void>
  /** Close the transport and release USB resources */
  close(): Promise<void>
  /** Establish a TCP connection through the USB tunnel */
  connectTcp(host: string, port: number): Promise<TcpConnection>
}
