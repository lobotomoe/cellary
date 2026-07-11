/**
 * Huawei E8372 preparation profile.
 *
 * HiLink + AT dual-mode device. Runs standard health checks.
 * STK and USSD have known firmware limitations in HiLink mode.
 */

import { registrationCheck, simCheck } from '../../../../../../preparation/index.js'
import type { PrepProfile } from '../../../../../../preparation/types.js'

export const e8372PrepProfile: PrepProfile = {
  name: 'Huawei E8372 HiLink+AT',
  checks: [simCheck, registrationCheck],
  limitations: [
    {
      scope: 'stk',
      severity: 'info',
      description:
        'STK commands return CME ERROR 50 -- firmware owns the STK terminal in HiLink mode.',
    },
    {
      scope: 'ussd',
      severity: 'warning',
      description:
        'AT USSD blocked when HiLink active (CME ERROR 304). ' +
        'USSD is routed through HiLink HTTP API instead.',
    },
  ],
}
