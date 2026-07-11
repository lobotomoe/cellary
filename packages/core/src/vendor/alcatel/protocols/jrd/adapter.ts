import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type {
  Device,
  Network,
  ProtocolAdapter,
  ServiceCapability,
  ServiceName,
  Sim,
  Traffic,
} from '../../../../protocols/adapter.js'
import type { SmsCount } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { JrdDevice } from './device.js'
import { JrdNetwork } from './network.js'
import { JrdSim } from './sim.js'
import { JrdSmsCounter } from './sms-count.js'
import { JrdTraffic } from './traffic.js'

/**
 * Alcatel/TCL JRD JSON-RPC protocol adapter.
 *
 * Implements network, device, SIM, and traffic services via the JRD HTTP API.
 * All services use whitelist API methods (no authentication required).
 *
 * The JRD API provides:
 * - Rich signal data (RSSI, RSRP, RSRQ, SINR, band) via GetNetworkInfo
 * - Device info (IMEI, firmware, hardware version) via GetSystemInfo
 * - SIM status and ICCID via GetSimStatus + GetSystemInfo
 * - Traffic stats (bytes, speed, duration) via GetConnectionState
 * - SMS count via GetSMSStorageState
 *
 * Authenticated endpoints (SendSMS, Connect, settings) require login with
 * XOR-encrypted credentials -- not implemented yet.
 *
 * Accepts any JrdClient implementation (OS HTTP or userspace USB).
 * See client.ts for available implementations.
 */
export class JrdAdapter implements ProtocolAdapter {
  readonly kind = 'jrd' as const
  readonly network: Network
  readonly device: Device
  readonly sim: Sim
  readonly traffic: Traffic

  private readonly client: JrdClient
  private readonly _smsCounter: JrdSmsCounter
  private readonly _log: Logger

  constructor(client: JrdClient, logger?: Logger | undefined) {
    this._log = logger ?? noopLogger

    this.client = client
    this.network = new JrdNetwork(this.client, this._log.child({ service: 'network' }))
    this.device = new JrdDevice(this.client, this._log.child({ service: 'device' }))
    this.sim = new JrdSim(this.client, this._log.child({ service: 'sim' }))
    this.traffic = new JrdTraffic(this.client, this._log.child({ service: 'traffic' }))
    this._smsCounter = new JrdSmsCounter(this.client, this._log.child({ service: 'sms' }))
  }

  smsCount(): Promise<SmsCount> {
    return this._smsCounter.count()
  }

  async close(): Promise<void> {
    this.client.destroy()
  }

  serviceCapabilities(): Partial<Record<ServiceName, ServiceCapability>> {
    return {
      network: { priority: 10, reason: 'rich signal data (RSRP/RSRQ/SINR/band)' },
      device: { priority: 10, reason: 'IMEI + firmware + hardware version' },
      sim: { priority: 5, reason: 'no IMSI, no PIN entry' },
      traffic: { priority: 10, reason: 'session bytes + speed' },
    }
  }
}
