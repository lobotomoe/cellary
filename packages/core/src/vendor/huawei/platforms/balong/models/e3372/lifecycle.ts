/**
 * E3372 model-specific lifecycle layer.
 *
 * Adds the storage -> hilink_at edge for the HiLink firmware variant.
 * E3372 with HiLink firmware transitions to CDC Ethernet + AT mode.
 */

import type { StateGraphLayer } from '../../../../../../lifecycle/types.js'

export const E3372_LAYER: StateGraphLayer = {
  name: 'e3372',
  nodes: [],
  edges: [
    {
      from: 'storage',
      to: 'hilink_at',
      label: 'USB vendor control (HiLink firmware)',
      cost: 5,
      reversible: false,
      manual: false,
    },
  ],
}
