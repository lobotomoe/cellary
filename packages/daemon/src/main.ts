/**
 * cellary daemon entry point.
 *
 * Starts a privileged system service that owns USB modem devices.
 * CLI and GUI connect via Unix socket / named pipe to send commands
 * and receive events -- no sudo required for clients.
 */

import type { Logger } from 'cellary'
import {
  DEFAULT_RESOLVERS,
  DEFAULT_VENDORS,
  registerModeswitchHelper,
  USB_MODEM_DATABASE,
} from 'cellary'
import { pino } from 'pino'

import { FileAuditSink } from './audit-sink.js'
import { config } from './config.js'
import { DeviceManager } from './device-manager.js'
import { EventBridge } from './event-bridge.js'
import type { DaemonStatus } from './ipc/protocol.js'
import {
  claimSchema,
  deviceIdSchema,
  getSocketPath,
  provisionSchema,
  RPC_ERRORS,
  subscribeSchema,
  waitForReadySchema,
} from './ipc/protocol.js'
import { IpcServer } from './ipc/server.js'
import { streamCloseSchema, streamDataSchema, streamOpenSchema } from './ipc/stream-protocol.js'
import { dispatchServiceCall, isServiceMethod } from './service-proxy.js'
import { StreamManager } from './stream-manager.js'

const VERSION = '0.0.1'
const startedAt = Date.now()

// Register the helper script path so core can spawn it for SCSI CBW mode switching
const helperUrl = new URL('./modeswitch-helper.cjs', import.meta.url)
registerModeswitchHelper(helperUrl.pathname)

const pinoLog = pino({
  name: 'cellaryd',
  level: config.logLevel,
})

/** Wrap pino (data-first) to match cellary's Logger interface (msg-first). */
function wrapPino(p: typeof pinoLog): Logger {
  return {
    trace(msg, data) {
      p.trace(data ?? {}, msg)
    },
    debug(msg, data) {
      p.debug(data ?? {}, msg)
    },
    info(msg, data) {
      p.info(data ?? {}, msg)
    },
    warn(msg, data) {
      p.warn(data ?? {}, msg)
    },
    error(msg, data) {
      p.error(data ?? {}, msg)
    },
    child(bindings) {
      return wrapPino(p.child(bindings))
    },
  }
}

const log = wrapPino(pinoLog)

// ── Wire components ────────────────────────────────────────────────────────

const socketPath = getSocketPath()

let eventBridge: EventBridge
let deviceManager: DeviceManager
let streamManager: StreamManager

const server = new IpcServer({
  socketPath,
  socketGid: config.socketGid,
  onWarning: (message) => log.warn(message),

  onRequest: async (method, params, clientId) => {
    // ── Fleet management ─────────────────────────────────────────────
    if (method === 'devices.list') {
      return deviceManager.listDevices()
    }

    if (method === 'devices.waitForReady') {
      const { timeoutMs, deviceId } = waitForReadySchema.parse(params)
      return deviceManager.waitForReady(timeoutMs, deviceId)
    }

    if (method === 'devices.provision') {
      const { deviceId } = provisionSchema.parse(params)
      return deviceManager.provision(deviceId)
    }

    if (method === 'devices.claim') {
      const { deviceId, ttlMs } = claimSchema.parse(params)
      return deviceManager.claim(deviceId, clientId, ttlMs)
    }

    if (method === 'devices.release') {
      const { deviceId } = deviceIdSchema.parse(params)
      deviceManager.release(deviceId, clientId)
      return null
    }

    // ── Subscriptions ────────────────────────────────────────────────
    if (method === 'subscribe') {
      const { deviceId, events } = subscribeSchema.parse(params)
      eventBridge.subscribe(clientId, deviceId, events)
      return null
    }

    if (method === 'unsubscribe') {
      const { deviceId } = subscribeSchema.parse(params)
      eventBridge.unsubscribe(clientId, deviceId)
      return null
    }

    // ── Daemon management ────────────────────────────────────────────
    if (method === 'daemon.status') {
      const status: DaemonStatus = {
        uptime: Date.now() - startedAt,
        deviceCount: deviceManager.deviceCount,
        pid: process.pid,
        version: VERSION,
      }
      return status
    }

    if (method === 'daemon.shutdown') {
      log.info('Shutdown requested by client')
      // Graceful shutdown after responding
      setTimeout(() => shutdown().catch(() => process.exit(1)), 100)
      return null
    }

    // ── Streams ────────────────────────────────────────────────────
    if (method === 'stream.open') {
      const { deviceId, type } = streamOpenSchema.parse(params)
      const modem = deviceManager.getModemFor(deviceId, clientId)
      const system = modem.system
      if (type !== 'shell' || system.openInteractiveShell === undefined) {
        throw Object.assign(new Error(`Stream type '${type}' is not available on this device`), {
          code: RPC_ERRORS.SERVICE_UNAVAILABLE,
        })
      }
      const interactiveStream = await system.openInteractiveShell()
      const streamId = streamManager.openStream(clientId, deviceId, interactiveStream)
      return { streamId }
    }

    // ── Device reset (fleet-level, not a service call) ──────────────
    if (method === 'device.reset') {
      const { deviceId } = deviceIdSchema.parse(params)
      streamManager.removeDevice(deviceId)
      await deviceManager.resetDevice(deviceId)
      return null
    }

    // ── Device service calls ─────────────────────────────────────────
    if (isServiceMethod(method)) {
      const result = dispatchServiceCall(method, params, (deviceId) =>
        deviceManager.getModemFor(deviceId, clientId),
      )
      if (result !== undefined) return result
    }

    throw Object.assign(new Error(`Unknown method: ${method}`), {
      code: RPC_ERRORS.METHOD_NOT_FOUND,
    })
  },

  onNotification(method, params, clientId) {
    if (method === 'stream.data') {
      const { streamId, data } = streamDataSchema.parse(params)
      streamManager.handleData(clientId, streamId, data)
      return
    }
    if (method === 'stream.close') {
      const { streamId } = streamCloseSchema.parse(params)
      streamManager.handleClose(clientId, streamId)
    }
  },

  onClientConnected(clientId) {
    log.info('Client connected', { clientId })
  },

  onClientDisconnected(clientId) {
    log.info('Client disconnected', { clientId })
    eventBridge.removeClient(clientId)
    streamManager.removeClient(clientId)
    deviceManager.releaseLeases(clientId)
  },
})

eventBridge = new EventBridge(server)
streamManager = new StreamManager(server, log)

// Durable, append-only device-comms audit, separate from the pino app log.
const auditSink = new FileAuditSink(config.auditFile, {
  maxBytes: config.auditMaxBytes,
  retentionMs: config.auditRetentionMs,
  onWarn: (message, err) => log.warn(message, { error: err }),
})

deviceManager = new DeviceManager({
  vendors: DEFAULT_VENDORS,
  resolvers: DEFAULT_RESOLVERS,
  modemDatabase: USB_MODEM_DATABASE,
  logger: log,
  createAuditSink: (deviceId) => ({
    // Audit is best-effort from core's perspective: a sink failure must never
    // break device comms, so swallow-and-log at this boundary.
    record: (record) => {
      try {
        auditSink.append(deviceId, record)
      } catch (err) {
        log.error('Audit append failed', { deviceId, error: err })
      }
    },
  }),
  onDeviceEvent(deviceId, event, data) {
    // Device lifecycle events: broadcast to all clients
    if (event === 'device:added' || event === 'device:removed' || event === 'device:readiness') {
      if (event === 'device:removed') {
        streamManager.removeDevice(deviceId)
      }
      eventBridge.broadcastDeviceEvent(deviceId, event, data)
      return
    }
    // Modem events: forward to subscribed clients only
    eventBridge.forward(deviceId, event, data)
  },
})

// ── Startup ────────────────────────────────────────────────────────────────

async function startup(): Promise<void> {
  log.info('Starting cellary daemon', { pid: process.pid, socket: socketPath })

  await server.start()
  log.info('IPC server listening', { socket: socketPath })

  await deviceManager.start()
  log.info('Device manager started, watching for USB modems')
}

async function shutdown(): Promise<void> {
  log.info('Shutting down')

  streamManager.closeAll()
  await deviceManager.stop()
  await server.stop()
  auditSink.close()

  log.info('Shutdown complete')
  process.exit(0)
}

// ── Signal handling ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  shutdown().catch((err: unknown) => {
    log.error('Shutdown error', { error: err })
    process.exit(1)
  })
})

process.on('SIGINT', () => {
  shutdown().catch((err: unknown) => {
    log.error('Shutdown error', { error: err })
    process.exit(1)
  })
})

process.on('uncaughtException', (err) => {
  pinoLog.fatal({ error: err }, 'Uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  pinoLog.fatal({ reason }, 'Unhandled rejection')
  process.exit(1)
})

// ── Run ────────────────────────────────────────────────────────────────────

startup().catch((err: unknown) => {
  pinoLog.fatal({ error: err }, 'Failed to start daemon')
  process.exit(1)
})
