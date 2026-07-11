/**
 * Stream multiplexing protocol types for IPC.
 *
 * Defines the three stream message types:
 * - stream.open (RPC request/response) -- establishes a stream, returns streamId
 * - stream.data (notification, bidirectional) -- carries base64-encoded binary data
 * - stream.close (notification, bidirectional) -- terminates a stream
 */

import { z } from 'zod'

// ── Stream types ────────────────────────────────────────────────────────────

const STREAM_TYPES = ['shell'] as const

export type StreamType = (typeof STREAM_TYPES)[number]

// ── Server-side param validation (client -> daemon) ─────────────────────────

export const streamOpenSchema = z.object({
  deviceId: z.string(),
  type: z.enum(STREAM_TYPES),
})

export const streamDataSchema = z.object({
  streamId: z.string(),
  data: z.string(),
})

export const streamCloseSchema = z.object({
  streamId: z.string(),
})

// ── Client-side response validation (daemon -> client) ──────────────────────

export const streamOpenResultSchema = z.object({
  streamId: z.string(),
})

// ── Derived types ───────────────────────────────────────────────────────────

export type StreamOpenParams = z.infer<typeof streamOpenSchema>
export type StreamDataParams = z.infer<typeof streamDataSchema>
export type StreamCloseParams = z.infer<typeof streamCloseSchema>
export type StreamOpenResult = z.infer<typeof streamOpenResultSchema>
