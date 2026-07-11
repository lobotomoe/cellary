/**
 * Huawei E3372 preparation profile.
 *
 * LTE Cat4 data stick. Standard health checks apply.
 * Voice and STK are broken at firmware level.
 */

import { registrationCheck, simCheck } from '../../../../../../preparation/index.js'
import type { PrepProfile } from '../../../../../../preparation/types.js'

export const e3372PrepProfile: PrepProfile = {
  name: 'Huawei E3372 Stick',
  checks: [simCheck, registrationCheck],
  limitations: [
    {
      scope: 'voice',
      severity: 'critical',
      description:
        'Voice calls not functional. ATD returns OK but call setup never starts (no ^ORIG URC).',
      workaround: 'Use a 3G HSPA modem for voice (E153, E1550, E173) or Quectel EC25.',
    },
    {
      scope: 'stk',
      severity: 'critical',
      description:
        'STK proactive commands (^STIN) never delivered to AT port despite ^STSF=1 accepting.',
    },
    {
      scope: 'sim',
      severity: 'info',
      description:
        'AT+CCID hangs instead of returning ERROR. ICCID retrieved via AT^ICCID? (Huawei vendor command).',
    },
  ],
}
