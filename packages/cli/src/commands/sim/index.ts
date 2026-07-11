import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'sim',
    description: 'SIM security commands (PIN, facility locks, passwords)',
  },
  subCommands: {
    pin: () => import('./pin.js').then((m) => m.default),
    retries: () => import('./retries.js').then((m) => m.default),
    lock: () => import('./lock.js').then((m) => m.default),
    unlock: () => import('./unlock.js').then((m) => m.default),
    query: () => import('./query.js').then((m) => m.default),
    password: () => import('./password.js').then((m) => m.default),
  },
})
