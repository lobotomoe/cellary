import { networkInterfaces } from 'node:os'

interface ModemInterface {
  /** OS interface name (e.g. 'en7') */
  readonly name: string
  /** Host IPv4 address on the modem's subnet (e.g. '192.168.8.100') */
  readonly address: string
}

/**
 * Find the OS network interface connected to a modem's subnet.
 *
 * Matches by /24 subnet: if the gateway is 192.168.8.1, finds the interface
 * with an IPv4 address like 192.168.8.x. Returns undefined when no match
 * is found (serial-only device, interface not yet up, etc.).
 */
export function findModemInterface(gatewayIp: string): ModemInterface | undefined {
  const gatewayParts = gatewayIp.split('.')
  if (gatewayParts.length !== 4) return undefined

  const [gA, gB, gC] = gatewayParts

  const ifaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (addrs === undefined) continue
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue

      const [hA, hB, hC] = addr.address.split('.')
      if (hA === gA && hB === gB && hC === gC) {
        return { name, address: addr.address }
      }
    }
  }

  return undefined
}
