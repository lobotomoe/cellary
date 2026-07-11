/**
 * Generic USB device state graph.
 *
 * The foundation layer that all vendors build upon. Defines universal
 * states that any USB modem can be in, regardless of vendor or model.
 *
 * States:
 *   absent    -- device not on the USB bus
 *   storage   -- CD-ROM / mass storage mode (needs mode switch)
 *   modem     -- operational modem mode (AT, serial, vendor API)
 *   download  -- firmware download mode
 *   emergency -- BootROM / EDL mode (recovery)
 *
 * Transitions:
 *   absent -> storage   (plugged in, auto-enumerates as storage)
 *   absent -> modem     (plugged in, auto-enumerates as modem)
 *   storage -> modem    (mode switch via USB control transfer or SCSI)
 *   modem -> absent     (unplugged)
 *   storage -> absent   (unplugged)
 *   download -> absent  (unplugged)
 *   emergency -> absent (unplugged)
 */

import type { StateGraphLayer } from './types.js'

export const GENERIC_LAYER: StateGraphLayer = {
  name: 'generic',
  nodes: [
    {
      id: 'absent',
      label: 'Not connected',
      severity: 'normal',
    },
    {
      id: 'storage',
      label: 'Storage / CD-ROM mode',
      severity: 'degraded',
      tags: ['switchable'],
    },
    {
      id: 'modem',
      label: 'Modem mode',
      severity: 'normal',
      terminal: true,
      tags: ['usable'],
    },
    {
      id: 'download',
      label: 'Firmware download mode',
      severity: 'degraded',
      tags: ['flash'],
    },
    {
      id: 'emergency',
      label: 'Emergency / BootROM mode',
      severity: 'critical',
      tags: ['recovery'],
    },
  ],
  edges: [
    // Plug-in transitions (hardware, not actionable by software)
    {
      from: 'absent',
      to: 'storage',
      label: 'Device plugged in (storage mode)',
      cost: 100,
      reversible: true,
      manual: true,
    },
    {
      from: 'absent',
      to: 'modem',
      label: 'Device plugged in (modem mode)',
      cost: 100,
      reversible: true,
      manual: true,
    },

    // Mode switch (the primary software-actionable transition)
    {
      from: 'storage',
      to: 'modem',
      label: 'USB mode switch',
      cost: 5,
      reversible: false,
      manual: false,
    },

    // Unplug transitions
    {
      from: 'modem',
      to: 'absent',
      label: 'Device unplugged',
      cost: 100,
      reversible: true,
      manual: true,
    },
    {
      from: 'storage',
      to: 'absent',
      label: 'Device unplugged',
      cost: 100,
      reversible: true,
      manual: true,
    },
    {
      from: 'download',
      to: 'absent',
      label: 'Device unplugged',
      cost: 100,
      reversible: true,
      manual: true,
    },
    {
      from: 'emergency',
      to: 'absent',
      label: 'Device unplugged',
      cost: 100,
      reversible: true,
      manual: true,
    },
  ],
}
