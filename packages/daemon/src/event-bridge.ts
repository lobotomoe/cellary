/**
 * Event bridge: manages per-client event subscriptions.
 *
 * When a client subscribes to events for a device, the bridge forwards
 * matching device events as JSON-RPC notifications to that client.
 */

import type { JsonRpcNotification } from './ipc/protocol.js'
import type { IpcServer } from './ipc/server.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface Subscription {
  readonly deviceId: string
  readonly events: Set<string>
}

// ── Event Bridge ───────────────────────────────────────────────────────────

export class EventBridge {
  private readonly _server: IpcServer

  /** clientId -> deviceId -> Set of event names. */
  private readonly _subscriptions = new Map<string, Map<string, Subscription>>()

  constructor(server: IpcServer) {
    this._server = server
  }

  /** Subscribe a client to events from a device. */
  subscribe(clientId: string, deviceId: string, events: string[]): void {
    let clientSubs = this._subscriptions.get(clientId)
    if (!clientSubs) {
      clientSubs = new Map()
      this._subscriptions.set(clientId, clientSubs)
    }

    const existing = clientSubs.get(deviceId)
    if (existing) {
      // Merge events into existing subscription
      for (const event of events) {
        existing.events.add(event)
      }
    } else {
      clientSubs.set(deviceId, {
        deviceId,
        events: new Set(events),
      })
    }
  }

  /** Remove all subscriptions for a client-device pair. */
  unsubscribe(clientId: string, deviceId: string): void {
    const clientSubs = this._subscriptions.get(clientId)
    if (clientSubs) {
      clientSubs.delete(deviceId)
      if (clientSubs.size === 0) {
        this._subscriptions.delete(clientId)
      }
    }
  }

  /** Remove all subscriptions for a client (called on disconnect). */
  removeClient(clientId: string): void {
    this._subscriptions.delete(clientId)
  }

  /**
   * Forward a device event to all subscribed clients.
   * Called by DeviceManager's event handler.
   */
  forward(deviceId: string, event: string, data: unknown): void {
    for (const [clientId, clientSubs] of this._subscriptions) {
      const sub = clientSubs.get(deviceId)
      if (!sub) continue

      // Check if this client subscribed to this event (or '*' for all)
      if (!sub.events.has(event) && !sub.events.has('*')) continue

      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'event',
        params: { deviceId, event, data },
      }
      this._server.notify(clientId, notification)
    }
  }

  /**
   * Broadcast a device event to ALL connected clients, regardless of subscriptions.
   * Used for critical events like device:added, device:removed, device:readiness.
   */
  broadcastDeviceEvent(deviceId: string, event: string, data: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'event',
      params: { deviceId, event, data },
    }
    this._server.broadcast(notification)
  }
}
