/**
 * Network registration health check.
 *
 * Verifies that the modem is registered on a cellular network.
 * "Searching" is reported as degraded (may resolve on its own).
 */

import type { Logger } from '../logger.js'
import type { HealthCheck, PreparationTarget, StepOutcome } from './types.js'

export const registrationCheck: HealthCheck = {
  id: 'registration',
  name: 'Network registration',
  kind: 'diagnostic',

  async execute(modem: PreparationTarget, log: Logger): Promise<StepOutcome> {
    try {
      const reg = await modem.network.registration()

      switch (reg.status) {
        case 'home':
          return {
            status: 'passed',
            detail: `Registered (home)${reg.technology ? ` ${reg.technology}` : ''}`,
          }

        case 'roaming':
          return {
            status: 'passed',
            detail: `Registered (roaming)${reg.technology ? ` ${reg.technology}` : ''}`,
          }

        case 'searching':
          return {
            status: 'degraded',
            detail: 'Searching for network -- may take up to 60 seconds',
          }

        case 'denied':
          return {
            status: 'degraded',
            detail: 'Network registration denied -- check SIM card and operator',
          }

        case 'notRegistered':
          return {
            status: 'failed',
            error: 'Not registered on any network',
            recoverable: true,
          }

        case 'unknown':
          return {
            status: 'degraded',
            detail: 'Registration status unknown',
          }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('Registration check failed', { error: message })
      return {
        status: 'failed',
        error: `Registration query failed: ${message}`,
        recoverable: true,
      }
    }
  },
}
