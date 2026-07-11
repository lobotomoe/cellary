import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'network',
    description: 'Network operator commands (scan, select, auto, status, preferred, operators)',
  },
  subCommands: {
    scan: () => import('./scan.js').then((m) => m.default),
    select: () => import('./select.js').then((m) => m.default),
    auto: () => import('./auto.js').then((m) => m.default),
    status: () => import('./status.js').then((m) => m.default),
    preferred: () => import('./preferred.js').then((m) => m.default),
    operators: () => import('./operators.js').then((m) => m.default),
  },
})
