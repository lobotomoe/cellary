import { defineCommand, runMain } from 'citty'

// Force exit on SIGINT. Without this, pending USB transfers (libusb)
// keep the event loop alive and Ctrl+C doesn't terminate the process.
process.on('SIGINT', () => process.exit(130))

const main = defineCommand({
  meta: {
    name: 'cellary',
    version: '0.0.1',
    description: 'Your SIM card as an API',
  },
  subCommands: {
    devices: () => import('./commands/devices.js').then((m) => m.default),
    info: () => import('./commands/info.js').then((m) => m.default),
    signal: () => import('./commands/signal.js').then((m) => m.default),
    network: () => import('./commands/network/index.js').then((m) => m.default),
    sms: () => import('./commands/sms/index.js').then((m) => m.default),
    ussd: () => import('./commands/ussd.js').then((m) => m.default),
    sim: () => import('./commands/sim/index.js').then((m) => m.default),
    init: () => import('./commands/init.js').then((m) => m.default),
    up: () => import('./commands/monitor/index.js').then((m) => m.default),
    diagnose: () => import('./commands/diagnose.js').then((m) => m.default),
    watch: () => import('./commands/watch.js').then((m) => m.default),
    daemon: () => import('./commands/daemon/index.js').then((m) => m.default),
    system: () => import('./commands/system/index.js').then((m) => m.default),
    thermal: () => import('./commands/thermal.js').then((m) => m.default),
  },
})

runMain(main).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
