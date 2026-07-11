/**
 * Balong platform lifecycle state graph.
 *
 * Platform-level layer for Huawei devices based on the Balong chipset.
 * Adds the HDLC download mode state and transitions to/from it.
 *
 *   - balong_download -- Balong HDLC flash mode (refines 'download')
 *
 * Composed after HUAWEI_LAYER. Model-specific edges live in
 * models/<model>/lifecycle.ts.
 */

import type { StateGraphLayer } from '../../../../lifecycle/types.js'

export const BALONG_LAYER: StateGraphLayer = {
  name: 'balong',
  nodes: [
    {
      id: 'balong_download',
      label: 'Balong HDLC download mode',
      severity: 'degraded',
      refines: 'download',
      tags: ['flash', 'hdlc'],
    },
  ],
  edges: [
    // Download mode entry (AT^GODLOAD on any AT-capable state)
    {
      from: 'hilink_at',
      to: 'balong_download',
      label: 'AT^GODLOAD (enter download mode)',
      cost: 5,
      reversible: false,
      manual: false,
    },
    {
      from: 'stick',
      to: 'balong_download',
      label: 'AT^GODLOAD (enter download mode)',
      cost: 5,
      reversible: false,
      manual: false,
    },

    // Download mode exit (flash complete + HDLC reboot)
    {
      from: 'balong_download',
      to: 'storage',
      label: 'HDLC reboot after flash',
      cost: 50,
      reversible: false,
      manual: false,
    },
  ],
}
