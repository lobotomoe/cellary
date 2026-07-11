import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'daemon',
    description: 'Manage the cellary daemon (start, stop, status, install)',
  },
  subCommands: {
    start: () => import('./start.js').then((m) => m.default),
    stop: () => import('./stop.js').then((m) => m.default),
    status: () => import('./status.js').then((m) => m.default),
    install: () => import('./install.js').then((m) => m.default),
    uninstall: () => import('./uninstall.js').then((m) => m.default),
  },
})
