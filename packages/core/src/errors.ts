import type { PrepReport } from './preparation/types.js'
import type { ATResultCode } from './protocols/at/types.js'

/** Base error for all cellary errors */
export class CellaryError extends Error {
  override name = 'CellaryError'

  readonly shortMessage: string
  readonly details?: string | undefined

  constructor(shortMessage: string, options?: { cause?: unknown; details?: string | undefined }) {
    const causeMessage = options?.cause instanceof Error ? options.cause.message : undefined
    const details = options?.details ?? causeMessage
    const message = [shortMessage, ...(details ? [`Details: ${details}`] : [])].join('\n')

    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.shortMessage = shortMessage
    this.details = details
  }
}

/** AT command returned an error result code */
export class ATError extends CellaryError {
  override name = 'ATError'

  readonly command: string
  readonly result: ATResultCode

  constructor(command: string, result: ATResultCode) {
    const detail = formatResultCode(result)
    super(`AT command failed: ${command}`, { details: detail })
    this.command = command
    this.result = result
  }
}

/** AT command did not receive a response within the timeout */
export class TimeoutError extends CellaryError {
  override name = 'TimeoutError'

  readonly command: string
  readonly timeoutMs: number

  constructor(command: string, timeoutMs: number) {
    super(`AT command timed out after ${timeoutMs}ms: ${command}`)
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

/** Transport-level error (port open/close/write failure) */
export class TransportError extends CellaryError {
  override name = 'TransportError'
}

/** Failed to parse modem response */
export class ParseError extends CellaryError {
  override name = 'ParseError'

  readonly rawData: string

  constructor(message: string, rawData: string) {
    super(message, { details: `Raw: ${rawData}` })
    this.rawData = rawData
  }
}

/** Device discovery failure (no device found, mode switch failed, etc.) */
export class DiscoveryError extends CellaryError {
  override name = 'DiscoveryError'
}

/** AT channel has been disposed and cannot accept commands */
export class ChannelDisposedError extends CellaryError {
  override name = 'ChannelDisposedError'

  constructor() {
    super('Channel has been disposed')
  }
}

/** AT channel detected firmware is unresponsive (e.g. Balong TAF hung without SIM) */
export class ChannelUnresponsiveError extends CellaryError {
  override name = 'ChannelUnresponsiveError'

  constructor(reason?: string) {
    super(reason ?? 'Channel unresponsive: firmware is not processing AT commands')
  }
}

/** SIM Toolkit operation error (invalid state, unexpected response) */
export class StkError extends CellaryError {
  override name = 'StkError'
}

/** AT command queue is full — modem cannot keep up with command rate */
export class QueueFullError extends CellaryError {
  override name = 'QueueFullError'

  readonly command: string
  readonly queueSize: number

  constructor(command: string, queueSize: number) {
    super(`Command queue full (${queueSize} pending): ${command}`)
    this.command = command
    this.queueSize = queueSize
  }
}

/** Requested service is not supported by any available protocol adapter */
export class NotSupportedError extends CellaryError {
  override name = 'NotSupportedError'

  readonly service: string
  readonly protocols: readonly string[]

  constructor(service: string, protocols?: readonly string[]) {
    const hint =
      protocols !== undefined && protocols.length > 0
        ? ` (active protocols: ${protocols.join(', ')})`
        : ''
    super(`Service not supported: ${service}${hint}`)
    this.service = service
    this.protocols = protocols ?? []
  }
}

/** Device preparation failed (mode switch, health check, etc.) */
export class PreparationError extends CellaryError {
  override name = 'PreparationError'

  readonly report: PrepReport

  constructor(report: PrepReport) {
    const failedSteps = report.steps.filter((s) => s.outcome.status === 'failed').map((s) => s.name)
    const summary =
      failedSteps.length > 0
        ? `Device preparation failed: ${failedSteps.join(', ')}`
        : 'Device preparation failed'
    super(summary)
    this.report = report
  }
}

function formatResultCode(result: ATResultCode): string {
  switch (result.type) {
    case 'error':
      return 'ERROR'
    case 'cme_error':
      // code=-1 means verbose mode (modem already sent the message text)
      return result.code >= 0
        ? `+CME ERROR ${result.code}: ${result.message}`
        : `+CME ERROR: ${result.message}`
    case 'cms_error':
      return result.code >= 0
        ? `+CMS ERROR ${result.code}: ${result.message}`
        : `+CMS ERROR: ${result.message}`
    case 'no_carrier':
      return 'NO CARRIER'
    case 'busy':
      return 'BUSY'
    case 'no_answer':
      return 'NO ANSWER'
    case 'no_dialtone':
      return 'NO DIALTONE'
    case 'ok':
      return 'OK'
  }
}
