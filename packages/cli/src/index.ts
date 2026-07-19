import { defineCommand, runMain } from 'citty'

/** Grace period for command cleanup after Ctrl+C before we force-exit. */
const FORCE_EXIT_GRACE_MS = 2000

// SIGINT handling. Pending USB transfers (libusb) keep the event loop alive, so
// a stuck process needs a force-exit escape hatch. But blindly exiting here also
// kills command-registered cleanup (monitor alt-screen restore, watch teardown,
// serial port close). So: if a command installed its own SIGINT handler, let it
// own the shutdown and only force-exit as a delayed safety net (second Ctrl+C
// exits now). With no command handler, exit immediately as before.
let interrupting = false
process.on('SIGINT', () => {
  if (process.listenerCount('SIGINT') <= 1) {
    process.exit(130)
  }
  if (interrupting) process.exit(130)
  interrupting = true
  setTimeout(() => process.exit(130), FORCE_EXIT_GRACE_MS).unref()
})

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
