/**
 * Address types for the userspace USB networking transports (RNDIS, ECM).
 *
 * tcpip expects template-literal typed strings for tap interface addresses.
 * These helpers produce them from runtime-validated input instead of asserting.
 */

import { TransportError } from '../errors.js'

/** IPv4 address with prefix length, e.g. '192.168.1.100/24'. */
export type Ipv4Cidr = `${number}.${number}.${number}.${number}/${number}`

/** Colon-separated MAC address, e.g. '02:00:5e:00:53:01'. */
export type MacAddress = `${string}:${string}:${string}:${string}:${string}:${string}`

const CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
const MAX_OCTET = 255
const MAX_PREFIX_LENGTH = 32
const MAC_OCTETS = 6

export function isIpv4Cidr(value: string): value is Ipv4Cidr {
  const match = CIDR_REGEX.exec(value)
  if (match === null) return false
  const [, a, b, c, d, prefix] = match
  const octets = [a, b, c, d]
  const octetsValid = octets.every((o) => o !== undefined && Number(o) <= MAX_OCTET)
  return octetsValid && prefix !== undefined && Number(prefix) <= MAX_PREFIX_LENGTH
}

/**
 * Validate a local-side CIDR before it reaches the TCP/IP stack. A malformed
 * option would otherwise surface as an opaque failure deep inside lwIP.
 */
export function parseIpv4Cidr(value: string): Ipv4Cidr {
  if (!isIpv4Cidr(value)) {
    throw new TransportError(`Invalid IPv4 CIDR for the local interface: '${value}'`)
  }
  return value
}

/**
 * Derive a locally-administered MAC for the host side from the device's MAC:
 * set the locally-administered bit, clear the multicast bit, and bump the
 * last octet so the two ends of the link never share an address.
 */
export function deriveLocalMac(deviceMac: string): MacAddress {
  const parts = deviceMac.split(':')
  if (parts.length !== MAC_OCTETS) {
    throw new TransportError(`Device reported a malformed MAC address: '${deviceMac}'`)
  }
  const [first = '02', second = '00', third = '00', fourth = '00', fifth = '00', last = '01'] =
    parts
  const firstOctet = (Number.parseInt(first, 16) | 0x02) & 0xfe
  const lastOctet = (Number.parseInt(last, 16) + 1) & 0xff
  const firstHex = firstOctet.toString(16).padStart(2, '0')
  const lastHex = lastOctet.toString(16).padStart(2, '0')
  return `${firstHex}:${second}:${third}:${fourth}:${fifth}:${lastHex}`
}
