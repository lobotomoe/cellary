/**
 * E8372 model-specific lifecycle layer.
 *
 * Adds the storage -> hilink_only edge: E8372 can land in HiLink-only
 * mode when U2DIAG NV is set to 0, which is an alternate outcome of
 * the same USB vendor control transfer.
 */

import type { StateGraphLayer } from '../../../../../../lifecycle/types.js'

export const E8372_LAYER: StateGraphLayer = {
  name: 'e8372',
  nodes: [],
  edges: [
    {
      from: 'storage',
      to: 'hilink_only',
      label: 'USB vendor control (U2DIAG=0, lands on HiLink-only)',
      cost: 5,
      reversible: false,
      manual: false,
    },
  ],
}
