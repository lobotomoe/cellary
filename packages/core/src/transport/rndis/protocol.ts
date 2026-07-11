/**
 * RNDIS (Remote NDIS) protocol message builders and parsers.
 *
 * Implements the subset of RNDIS needed to initialize a USB RNDIS device
 * and exchange Ethernet frames: INITIALIZE, SET, QUERY, HALT, and PACKET.
 *
 * All multi-byte fields are little-endian per the RNDIS specification.
 */

// ── Message types ───────────────────────────────────────────────────────────

const MSG_INITIALIZE = 0x00000002
const MSG_INITIALIZE_CMPLT = 0x80000002
const MSG_QUERY = 0x00000004
const MSG_QUERY_CMPLT = 0x80000004
const MSG_SET = 0x00000005
const MSG_SET_CMPLT = 0x80000005
const MSG_HALT = 0x00000006
const MSG_PACKET = 0x00000001

// ── OIDs ────────────────────────────────────────────────────────────────────

const OID_GEN_CURRENT_PACKET_FILTER = 0x0001010e
const OID_802_3_PERMANENT_ADDRESS = 0x01010101

// Packet filter flags
const NDIS_PACKET_TYPE_DIRECTED = 0x00000001
const NDIS_PACKET_TYPE_MULTICAST = 0x00000002
const NDIS_PACKET_TYPE_BROADCAST = 0x00000008
const PACKET_FILTER =
  NDIS_PACKET_TYPE_DIRECTED | NDIS_PACKET_TYPE_MULTICAST | NDIS_PACKET_TYPE_BROADCAST

// ── RNDIS status codes ──────────────────────────────────────────────────────

const RNDIS_STATUS_SUCCESS = 0x00000000

const RNDIS_PACKET_HEADER_SIZE = 44
const DEFAULT_MAX_TRANSFER_SIZE = 0x00004000 // 16 KB

// ── Response types ──────────────────────────────────────────────────────────

export interface InitializeResponse {
  readonly type: 'initialize_cmplt'
  readonly requestId: number
  readonly status: number
  readonly maxTransferSize: number
}

export interface SetResponse {
  readonly type: 'set_cmplt'
  readonly requestId: number
  readonly status: number
}

export interface QueryResponse {
  readonly type: 'query_cmplt'
  readonly requestId: number
  readonly status: number
  readonly data: Uint8Array
}

export interface UnknownResponse {
  readonly type: 'unknown'
  readonly messageType: number
}

export type RndisResponse = InitializeResponse | SetResponse | QueryResponse | UnknownResponse

// ── Builders ────────────────────────────────────────────────────────────────

/** Build RNDIS_INITIALIZE_MSG (24 bytes) */
export function buildInitializeMsg(requestId: number): Uint8Array {
  const buf = new ArrayBuffer(24)
  const view = new DataView(buf)
  view.setUint32(0, MSG_INITIALIZE, true) // MessageType
  view.setUint32(4, 24, true) // MessageLength
  view.setUint32(8, requestId, true) // RequestId
  view.setUint32(12, 1, true) // MajorVersion
  view.setUint32(16, 0, true) // MinorVersion
  view.setUint32(20, DEFAULT_MAX_TRANSFER_SIZE, true) // MaxTransferSize
  return new Uint8Array(buf)
}

/** Build RNDIS_SET_MSG for OID_GEN_CURRENT_PACKET_FILTER (32 bytes) */
export function buildSetPacketFilterMsg(requestId: number): Uint8Array {
  const buf = new ArrayBuffer(32)
  const view = new DataView(buf)
  view.setUint32(0, MSG_SET, true) // MessageType
  view.setUint32(4, 32, true) // MessageLength
  view.setUint32(8, requestId, true) // RequestId
  view.setUint32(12, OID_GEN_CURRENT_PACKET_FILTER, true) // Oid
  view.setUint32(16, 4, true) // InformationBufferLength
  view.setUint32(20, 20, true) // InformationBufferOffset (from byte 8)
  view.setUint32(24, 0, true) // DeviceVcHandle
  view.setUint32(28, PACKET_FILTER, true) // Filter value
  return new Uint8Array(buf)
}

/** Build RNDIS_QUERY_MSG for OID_802_3_PERMANENT_ADDRESS (28 bytes) */
export function buildQueryMacMsg(requestId: number): Uint8Array {
  const buf = new ArrayBuffer(28)
  const view = new DataView(buf)
  view.setUint32(0, MSG_QUERY, true) // MessageType
  view.setUint32(4, 28, true) // MessageLength
  view.setUint32(8, requestId, true) // RequestId
  view.setUint32(12, OID_802_3_PERMANENT_ADDRESS, true) // Oid
  view.setUint32(16, 0, true) // InformationBufferLength
  view.setUint32(20, 0, true) // InformationBufferOffset
  view.setUint32(24, 0, true) // DeviceVcHandle (reserved)
  return new Uint8Array(buf)
}

/** Build RNDIS_HALT_MSG (12 bytes) */
export function buildHaltMsg(requestId: number): Uint8Array {
  const buf = new ArrayBuffer(12)
  const view = new DataView(buf)
  view.setUint32(0, MSG_HALT, true) // MessageType
  view.setUint32(4, 12, true) // MessageLength
  view.setUint32(8, requestId, true) // RequestId
  return new Uint8Array(buf)
}

// ── Packet framing ──────────────────────────────────────────────────────────

/** Wrap an Ethernet frame in RNDIS_PACKET_MSG header */
export function buildPacketMsg(ethFrame: Uint8Array): Uint8Array {
  const totalLength = RNDIS_PACKET_HEADER_SIZE + ethFrame.length
  const buf = new ArrayBuffer(totalLength)
  const view = new DataView(buf)

  view.setUint32(0, MSG_PACKET, true) // MessageType
  view.setUint32(4, totalLength, true) // MessageLength
  view.setUint32(8, 36, true) // DataOffset (relative to byte 8)
  view.setUint32(12, ethFrame.length, true) // DataLength
  // Bytes 16-43 are reserved (zeros from ArrayBuffer init)

  const result = new Uint8Array(buf)
  result.set(ethFrame, RNDIS_PACKET_HEADER_SIZE)
  return result
}

/**
 * Extract an Ethernet frame from an RNDIS_PACKET_MSG.
 * Returns undefined if the data is not a valid RNDIS packet.
 */
export function parsePacketMsg(data: Uint8Array): Uint8Array | undefined {
  if (data.length < RNDIS_PACKET_HEADER_SIZE) return undefined

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const msgType = view.getUint32(0, true)
  if (msgType !== MSG_PACKET) return undefined

  const dataOffset = view.getUint32(8, true)
  const dataLength = view.getUint32(12, true)

  // DataOffset is relative to byte 8 (the DataOffset field itself)
  const frameStart = 8 + dataOffset
  const frameEnd = frameStart + dataLength

  if (frameEnd > data.length) return undefined
  return data.slice(frameStart, frameEnd)
}

// ── Response parser ─────────────────────────────────────────────────────────

/** Parse an RNDIS control response (from GET_ENCAPSULATED_RESPONSE) */
export function parseResponse(data: Uint8Array): RndisResponse {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const msgType = view.getUint32(0, true)

  if (msgType === MSG_INITIALIZE_CMPLT) {
    return {
      type: 'initialize_cmplt',
      requestId: view.getUint32(8, true),
      status: view.getUint32(12, true),
      maxTransferSize: view.getUint32(24, true),
    }
  }

  if (msgType === MSG_SET_CMPLT) {
    return {
      type: 'set_cmplt',
      requestId: view.getUint32(8, true),
      status: view.getUint32(12, true),
    }
  }

  if (msgType === MSG_QUERY_CMPLT) {
    const status = view.getUint32(12, true)
    const infoLength = view.getUint32(16, true)
    const infoOffset = view.getUint32(20, true)
    // InfoOffset is relative to byte 8
    const start = 8 + infoOffset
    const responseData =
      infoLength > 0 && start + infoLength <= data.length
        ? data.slice(start, start + infoLength)
        : new Uint8Array(0)

    return {
      type: 'query_cmplt',
      requestId: view.getUint32(8, true),
      status,
      data: responseData,
    }
  }

  return { type: 'unknown', messageType: msgType }
}

/** Check if a status code indicates success */
export function isSuccess(status: number): boolean {
  return status === RNDIS_STATUS_SUCCESS
}
