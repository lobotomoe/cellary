/**
 * MiFi HTTP protocol adapter.
 *
 * Implements Network, Device, and SMS services via the MiFi management API
 * (POST /ajax with funcNo) over a userspace RNDIS USB transport.
 *
 * Unlike HiLinkAdapter which relies on OS-managed CDC-ECM networking,
 * MifiAdapter owns the full RNDIS transport lifecycle — USB claim,
 * RNDIS handshake, lwIP stack, TCP connections.
 *
 * No background polling — all requests are on-demand.
 * No persistent connection — each HTTP request opens a new TCP connection.
 */
import { EventEmitter } from 'node:events'

import type { Device as UsbDevice } from 'usb'
import { usb } from 'usb'

import type {
  Device,
  Network,
  ProtocolAdapter,
  ServiceCapability,
  ServiceName,
  Sms,
} from '../../../../protocols/adapter.js'
import { FUNC, mifiDeviceInfoSchema } from './api-types.js'
import type { MifiClient } from './client.js'
import { MifiDevice } from './device.js'
import { MifiNetwork } from './network.js'
import { MifiSms } from './sms.js'

const WARMUP_DELAY_MS = 5_000

export class MifiAdapter extends EventEmitter implements ProtocolAdapter {
  readonly kind = 'mifi'
  readonly network: Network
  readonly device: Device
  readonly sms: Sms

  private readonly _client: MifiClient
  private _disconnectHandler: (() => void) | undefined
  private _usbDetachListener: ((device: UsbDevice) => void) | undefined
  private _closing = false

  constructor(client: MifiClient) {
    super()
    this._client = client
    this.network = new MifiNetwork(client)
    this.device = new MifiDevice(client)
    this.sms = new MifiSms(client)
  }

  get baseUrl(): string {
    return `http://${this._client.gatewayIp}`
  }

  /**
   * Verify the device is reachable by querying device info (funcNo=1029).
   * Called by Modem after adapter creation.
   *
   * Accepts `onError` for interface consistency with ProtocolAdapter.init(),
   * but does not use it — device reachability is a hard requirement, not
   * a soft init step that can be skipped.
   */
  async init(_onError?: (step: string, err: Error) => void): Promise<void> {
    await this._client.call(FUNC.deviceInfo, mifiDeviceInfoSchema)
  }

  /**
   * Register a handler for unexpected USB disconnects.
   *
   * Listens for USB detach events matching our device's VID/PID.
   * On thermal reboot or cable pull, calls the handler so Modem
   * can trigger its reconnect loop.
   */
  onDisconnect(handler: () => void): void {
    this._disconnectHandler = handler

    // Clean up previous listener if any
    if (this._usbDetachListener) {
      usb.removeListener('detach', this._usbDetachListener)
    }

    const transport = this._client.transport
    const targetVid = transport.vendorId
    const targetPid = transport.productId

    this._usbDetachListener = (device: UsbDevice) => {
      const { idVendor, idProduct } = device.deviceDescriptor
      if (idVendor === targetVid && idProduct === targetPid && !this._closing) {
        this._disconnectHandler?.()
      }
    }

    usb.on('detach', this._usbDetachListener)
  }

  /**
   * Destroy and recreate the RNDIS transport.
   *
   * Called by Modem's reconnect loop after disconnect. Creates a fresh
   * lwIP stack and USB session. Waits for the device's HTTP server to
   * become responsive before returning.
   */
  async reopen(): Promise<void> {
    await this._client.reopen()

    // Give device time to initialize its HTTP server (Jetty)
    await new Promise((resolve) => setTimeout(resolve, WARMUP_DELAY_MS))
  }

  async close(): Promise<void> {
    this._closing = true
    if (this._usbDetachListener) {
      usb.removeListener('detach', this._usbDetachListener)
      this._usbDetachListener = undefined
    }
    await this._client.close()
  }

  serviceCapabilities(): Partial<Record<ServiceName, ServiceCapability>> {
    return {
      network: { priority: 5, reason: 'RSSI only' },
      device: { priority: 10, reason: 'IMEI + firmware' },
      sms: { priority: 10, reason: 'send + list + delete' },
    }
  }
}
