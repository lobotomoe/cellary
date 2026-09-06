import { NotSupportedError } from '../../../../errors.js'
import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { Sim } from '../../../../protocols/adapter.js'
import { normalizeIccid } from '../../../../protocols/iccid.js'
import type { SimInfo } from '../../../../types.js'
import type { JrdClient } from './client.js'
import { JRD_SIM_STATE, simStatusSchema, systemInfoSchema } from './schemas.js'

function mapSimState(state: number): SimInfo['state'] {
  switch (state) {
    case JRD_SIM_STATE.READY:
      return 'ready'
    case JRD_SIM_STATE.PIN_REQUIRED:
      return 'pinRequired'
    case JRD_SIM_STATE.PUK_REQUIRED:
    case JRD_SIM_STATE.PIN_BLOCKED:
      return 'pukRequired'
    case JRD_SIM_STATE.UNKNOWN:
      return 'absent'
    case JRD_SIM_STATE.PERSON_CHECK:
      return 'networkLocked'
    case JRD_SIM_STATE.ILLEGAL:
    case JRD_SIM_STATE.DETECTED:
    case JRD_SIM_STATE.INITING:
      return 'error'
    default:
      return 'error'
  }
}

/**
 * SIM service for Alcatel JRD HTTP API.
 *
 * Uses GetSimStatus (whitelist) for SIM state and GetSystemInfo for ICCID.
 * IMSI is not available via JRD whitelist API.
 * PIN entry requires authenticated session (not implemented).
 */
export class JrdSim implements Sim {
  private readonly _log: Logger

  constructor(
    private readonly client: JrdClient,
    logger?: Logger | undefined,
  ) {
    this._log = logger ?? noopLogger
  }

  async info(): Promise<SimInfo> {
    // Sequential: Alcatel's embedded HTTP server intermittently drops
    // concurrent requests (tested — fails non-deterministically).
    this._log.debug('JRD call', { method: 'GetSimStatus' })
    const simData = await this.client.call('GetSimStatus')
    this._log.debug('JRD call', { method: 'GetSystemInfo' })
    const sysData = await this.client.call('GetSystemInfo')

    const sim = simStatusSchema.parse(simData)
    const sys = systemInfoSchema.parse(sysData)

    return {
      iccid: sys.ICCID !== undefined ? normalizeIccid(sys.ICCID) : undefined,
      state: mapSimState(sim.SIMState),
    }
  }

  async iccid(): Promise<string> {
    this._log.debug('JRD call', { method: 'GetSystemInfo' })
    const data = await this.client.call('GetSystemInfo')
    const info = systemInfoSchema.parse(data)
    if (info.ICCID === undefined) {
      throw new Error('ICCID not available from JRD API')
    }
    return normalizeIccid(info.ICCID)
  }

  async imsi(): Promise<string> {
    // IMSI requires authenticated session -- not available via whitelist API
    throw new NotSupportedError('imsi (JRD whitelist API does not expose IMSI)')
  }

  async enterPin(_pin: string): Promise<void> {
    // PIN entry requires authenticated session with XOR encryption
    throw new NotSupportedError('enterPin (JRD auth not implemented)')
  }
}
