/**
 * SIM health check.
 *
 * Verifies that the SIM card is present and ready.
 * PIN-locked SIMs are reported as recoverable failures
 * (the user can still call modem.sim.enterPin()).
 */

import type { Logger } from '../logger.js'
import type { HealthCheck, PreparationTarget, StepOutcome } from './types.js'

export const simCheck: HealthCheck = {
  id: 'sim',
  name: 'SIM card',
  kind: 'diagnostic',

  async execute(modem: PreparationTarget, log: Logger): Promise<StepOutcome> {
    try {
      const sim = await modem.sim.info()

      switch (sim.state) {
        case 'ready': {
          const iccidLabel = sim.iccid !== undefined ? ` (ICCID: ${sim.iccid})` : ''
          return { status: 'passed', detail: `SIM ready${iccidLabel}` }
        }

        case 'pinRequired':
          return {
            status: 'failed',
            error: 'SIM PIN required',
            recoverable: true,
          }

        case 'pukRequired':
          return {
            status: 'failed',
            error: 'SIM PUK required -- too many wrong PIN attempts',
            recoverable: false,
          }

        case 'networkLocked':
          // Degraded, not failed: the modem itself is usable (device info, USSD,
          // etc.) -- only this SIM is rejected by the carrier lock. Failing here
          // would abort the whole connect and hide everything else.
          return {
            status: 'degraded',
            detail: 'SIM network-locked (carrier personalization) -- requires unlock code (NCK)',
          }

        case 'absent':
          return {
            status: 'degraded',
            detail: 'No SIM card detected',
          }

        case 'error':
          return {
            status: 'degraded',
            detail: 'SIM in error state (may be initializing)',
          }

        case 'unavailable':
          return {
            status: 'degraded',
            detail: 'SIM status unknown (all providers failed)',
          }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('SIM check failed', { error: message })
      return {
        status: 'degraded',
        detail: `SIM query failed: ${message}`,
      }
    }
  },
}
