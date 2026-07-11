import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'system',
    description: 'System commands (shell, ttl, at)',
  },
  subCommands: {
    shell: () => import('./shell.js').then((m) => m.default),
    ttl: () => import('./ttl.js').then((m) => m.default),
    at: () => import('./at.js').then((m) => m.default),
  },
})
