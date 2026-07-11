/**
 * Client-side InteractiveStream proxy over IPC.
 *
 * Translates InteractiveStream read/write operations into JSON-RPC
 * notifications sent over the daemon socket. Binary data is base64-encoded.
 *
 * Instantiated by DaemonClient.openStream(). Internal methods (_receiveData,
 * _receiveClose) are called by DaemonClient when matching notifications arrive.
 */

import type { InteractiveStream } from 'cellary'

// ── Types ──────────────────────────────────────────────────────────────────

export type NotificationSender = (method: string, params: unknown) => void

// ── Remote Stream ──────────────────────────────────────────────────────────

export class RemoteInteractiveStream implements InteractiveStream {
  private readonly _streamId: string
  private readonly _send: NotificationSender
  private _dataHandler: ((data: Buffer) => void) | undefined
  private _closeHandler: (() => void) | undefined
  private _closed = false

  constructor(streamId: string, sendNotification: NotificationSender) {
    this._streamId = streamId
    this._send = sendNotification
  }

  get streamId(): string {
    return this._streamId
  }

  // ── InteractiveStream interface ────────────────────────────────────────

  onData(handler: (data: Buffer) => void): void {
    this._dataHandler = handler
  }

  onClose(handler: () => void): void {
    this._closeHandler = handler
  }

  async write(data: Buffer): Promise<void> {
    if (this._closed) return
    this._send('stream.data', {
      streamId: this._streamId,
      data: data.toString('base64'),
    })
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    this._send('stream.close', { streamId: this._streamId })
    this._closeHandler?.()
  }

  // ── Internal: called by DaemonClient on incoming notifications ─────────

  /** Deliver incoming data from the daemon (base64-encoded). */
  _receiveData(base64Data: string): void {
    if (this._closed) return
    const buffer = Buffer.from(base64Data, 'base64')
    this._dataHandler?.(buffer)
  }

  /** Signal that the daemon closed this stream. */
  _receiveClose(): void {
    if (this._closed) return
    this._closed = true
    this._closeHandler?.()
  }
}
