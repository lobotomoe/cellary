/**
 * Huawei vendor lifecycle state graph.
 *
 * Vendor-level layer: states common to ALL Huawei devices, regardless
 * of chipset platform or specific model.
 *
 *   - hilink_only -- HiLink HTTP API only, no AT (refines 'modem')
 *   - hilink_at   -- HiLink HTTP + AT serial (refines 'modem', terminal)
 *   - stick       -- Pure AT stick mode, no HiLink (refines 'modem', terminal)
 *
 * Platform-specific states (balong_download) live in platforms/balong/lifecycle.ts.
 * Model-specific edges live in platforms/balong/models/<model>/lifecycle.ts.
 */

import type { StateGraphLayer } from '../../lifecycle/types.js'

export const HUAWEI_LAYER: StateGraphLayer = {
  name: 'huawei',
  nodes: [
    {
      id: 'hilink_only',
      label: 'HiLink only (no AT)',
      severity: 'degraded',
      refines: 'modem',
      tags: ['usable', 'http-only'],
    },
    {
      id: 'hilink_at',
      label: 'HiLink + AT',
      severity: 'normal',
      refines: 'modem',
      terminal: true,
      tags: ['usable', 'full-control'],
    },
    {
      id: 'stick',
      label: 'Stick mode (AT only)',
      severity: 'normal',
      refines: 'modem',
      terminal: true,
      tags: ['usable', 'at-only'],
    },
  ],
  edges: [
    // Storage -> modem mode transitions (vendor control transfer)
    {
      from: 'storage',
      to: 'hilink_at',
      label: 'USB vendor control (U2DIAG=256)',
      cost: 5,
      reversible: false,
      manual: false,
    },
    {
      from: 'storage',
      to: 'stick',
      label: 'USB vendor control (stick firmware)',
      cost: 5,
      reversible: false,
      manual: false,
    },

    // HiLink-only recovery path
    {
      from: 'hilink_only',
      to: 'storage',
      label: 'HiLink HTTP switchMode(0)',
      cost: 10,
      reversible: false,
      manual: false,
    },
  ],
}
