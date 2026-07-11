import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'sms',
    description: 'SMS commands (send, list)',
  },
  subCommands: {
    send: () => import('./send.js').then((m) => m.default),
    list: () => import('./list.js').then((m) => m.default),
  },
})
