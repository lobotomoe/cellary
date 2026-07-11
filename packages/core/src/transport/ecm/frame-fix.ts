/**
 * Workaround for tcpip.js (lwIP WASM) bug: when a TCP segment carries
 * both payload data and FIN flag, tcpip.js errors the ReadableStream
 * immediately, discarding the payload before the application can read it.
 *
 * Fix: intercept incoming Ethernet frames BEFORE they reach tcpip.
 * When a FIN+data TCP segment is detected, split it into two frames:
 *   1. Data-only frame (FIN cleared) — delivered immediately
 *   2. FIN-only frame (no payload) — delivered after a short delay
 *
 * Both frames have correct IP/TCP checksums recalculated from scratch.
 *
 * This module should be removed if/when tcpip.js fixes the underlying bug.
 * Tracked: tcpip@0.3.3 exhibits this behavior.
 */

const ETHERTYPE_IPV4 = 0x0800
const IP_PROTO_TCP = 6
const TCP_FLAG_FIN = 0x01

// Minimum frame size: Ethernet(14) + IP(20) + TCP(20)
const MIN_TCP_FRAME_LEN = 54

/**
 * Read a single byte from the frame.
 *
 * Indices past the end of the frame read as 0. That matches both the RFC
 * checksum convention (the final odd byte is padded with a zero byte) and the
 * value this code has always relied on: in the bitwise math below JavaScript
 * already coerces an out-of-range `undefined` to 0. Well-formed IPv4/TCP frames
 * never read past the end, so the fallback only ever applies to that padding.
 */
function byteAt(frame: Uint8Array, index: number): number {
  return frame[index] ?? 0
}

export interface SplitResult {
  /** Original frame with FIN cleared, full payload intact */
  readonly dataFrame: Uint8Array
  /** FIN-only frame: no payload, seq advanced past data */
  readonly finFrame: Uint8Array
}

/**
 * If `frame` is an IPv4/TCP segment carrying both data AND FIN,
 * return split frames. Otherwise return undefined (pass through as-is).
 */
export function splitFinData(frame: Uint8Array): SplitResult | undefined {
  if (frame.length < MIN_TCP_FRAME_LEN) return undefined

  // ── EtherType check ──────────────────────────────────────────────────
  const etherType = (byteAt(frame, 12) << 8) | byteAt(frame, 13)
  if (etherType !== ETHERTYPE_IPV4) return undefined

  // ── IP header ────────────────────────────────────────────────────────
  const ipOffset = 14
  if (byteAt(frame, ipOffset + 9) !== IP_PROTO_TCP) return undefined

  const ipHeaderLen = (byteAt(frame, ipOffset) & 0x0f) * 4

  // ── TCP header ───────────────────────────────────────────────────────
  const tcpOffset = ipOffset + ipHeaderLen
  const flags = byteAt(frame, tcpOffset + 13)
  if (!(flags & TCP_FLAG_FIN)) return undefined // no FIN, nothing to split

  const tcpHeaderLen = (byteAt(frame, tcpOffset + 12) >> 4) * 4
  const payloadLen = frame.length - tcpOffset - tcpHeaderLen
  if (payloadLen === 0) return undefined // pure FIN, no data to rescue

  // ── Build data frame (FIN cleared) ───────────────────────────────────
  const dataFrame = new Uint8Array(frame.length)
  dataFrame.set(frame)
  dataFrame[tcpOffset + 13] = flags & ~TCP_FLAG_FIN
  recalcTcpChecksum(dataFrame, ipOffset, ipHeaderLen, tcpOffset)

  // ── Build FIN frame (no payload, seq advanced) ───────────────────────
  const finFrameLen = ipOffset + ipHeaderLen + tcpHeaderLen
  const finFrame = new Uint8Array(finFrameLen)
  finFrame.set(frame.subarray(0, finFrameLen))

  // Update IP total length (no payload)
  const newIpTotalLen = ipHeaderLen + tcpHeaderLen
  finFrame[ipOffset + 2] = (newIpTotalLen >> 8) & 0xff
  finFrame[ipOffset + 3] = newIpTotalLen & 0xff

  // Advance TCP sequence number past the payload
  addToSeqNumber(finFrame, tcpOffset + 4, payloadLen)

  recalcIpChecksum(finFrame, ipOffset, ipHeaderLen)
  recalcTcpChecksum(finFrame, ipOffset, ipHeaderLen, tcpOffset)

  return { dataFrame, finFrame }
}

// ── Checksum helpers ───────────────────────────────────────────────────────

/**
 * Recalculate the IP header checksum from scratch.
 *
 * RFC 791: ones' complement of the ones' complement sum of all 16-bit
 * words in the header, with the checksum field zeroed during calculation.
 */
function recalcIpChecksum(frame: Uint8Array, ipOffset: number, ipHeaderLen: number): void {
  // Zero existing checksum
  frame[ipOffset + 10] = 0
  frame[ipOffset + 11] = 0

  let sum = 0
  for (let i = 0; i < ipHeaderLen; i += 2) {
    sum += (byteAt(frame, ipOffset + i) << 8) | byteAt(frame, ipOffset + i + 1)
  }

  // Fold 32-bit sum to 16 bits
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16)

  const checksum = ~sum & 0xffff
  frame[ipOffset + 10] = (checksum >> 8) & 0xff
  frame[ipOffset + 11] = checksum & 0xff
}

/**
 * Recalculate the TCP checksum from scratch.
 *
 * RFC 793: ones' complement sum over:
 *   1. Pseudo-header (src IP, dst IP, zero, protocol, TCP segment length)
 *   2. TCP header + payload
 */
function recalcTcpChecksum(
  frame: Uint8Array,
  ipOffset: number,
  ipHeaderLen: number,
  tcpOffset: number,
): void {
  // Zero existing checksum
  frame[tcpOffset + 16] = 0
  frame[tcpOffset + 17] = 0

  const tcpLen = frame.length - tcpOffset

  // ── Pseudo-header ────────────────────────────────────────────────────
  let sum = 0

  // Source IP (bytes 12-15 of IP header)
  const srcIpOff = ipOffset + 12
  sum += (byteAt(frame, srcIpOff) << 8) | byteAt(frame, srcIpOff + 1)
  sum += (byteAt(frame, srcIpOff + 2) << 8) | byteAt(frame, srcIpOff + 3)

  // Destination IP (bytes 16-19 of IP header)
  const dstIpOff = ipOffset + ipHeaderLen === 20 ? ipOffset + 16 : ipOffset + 16
  sum += (byteAt(frame, dstIpOff) << 8) | byteAt(frame, dstIpOff + 1)
  sum += (byteAt(frame, dstIpOff + 2) << 8) | byteAt(frame, dstIpOff + 3)

  // Zero + Protocol
  sum += IP_PROTO_TCP

  // TCP segment length
  sum += tcpLen

  // ── TCP header + payload ─────────────────────────────────────────────
  for (let i = 0; i < tcpLen - 1; i += 2) {
    sum += (byteAt(frame, tcpOffset + i) << 8) | byteAt(frame, tcpOffset + i + 1)
  }
  // Odd byte at end
  if (tcpLen % 2 !== 0) {
    sum += byteAt(frame, tcpOffset + tcpLen - 1) << 8
  }

  // Fold and complement
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16)

  const checksum = ~sum & 0xffff
  frame[tcpOffset + 16] = (checksum >> 8) & 0xff
  frame[tcpOffset + 17] = checksum & 0xff
}

/** Add `delta` to a 32-bit big-endian sequence number in-place */
function addToSeqNumber(frame: Uint8Array, offset: number, delta: number): void {
  const seq =
    ((byteAt(frame, offset) << 24) |
      (byteAt(frame, offset + 1) << 16) |
      (byteAt(frame, offset + 2) << 8) |
      byteAt(frame, offset + 3)) >>>
    0

  const newSeq = (seq + delta) >>> 0

  frame[offset] = (newSeq >> 24) & 0xff
  frame[offset + 1] = (newSeq >> 16) & 0xff
  frame[offset + 2] = (newSeq >> 8) & 0xff
  frame[offset + 3] = newSeq & 0xff
}
