/**
 * Huawei E5573 preparation profile.
 *
 * HiLink-only MiFi device. No USB AT interface -- AT access is through
 * ADB bridge (appvcom1) only, which may be unresponsive.
 * STK and USSD have known firmware limitations in HiLink mode.
 */

import { registrationCheck, simCheck } from '../../../../../../preparation/index.js'
import type { PrepProfile } from '../../../../../../preparation/types.js'

export const e5573PrepProfile: PrepProfile = {
  name: 'Huawei E5573 HiLink',
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
