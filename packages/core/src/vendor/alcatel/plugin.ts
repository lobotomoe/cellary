/**
 * Alcatel (TCL) vendor plugin.
 *
 * Discovers protocol adapters for Alcatel/TCL-manufactured modems.
 * Currently supports devices with the JRD JSON-RPC HTTP API
 * (e.g. Alcatel LINKZONE MW45V pocket MiFi).
 *
 * These devices expose CDC-ECM (Ethernet over USB) with no AT serial ports.
 * All modem control goes through the JRD HTTP API served by the device. That
 * API is reached either over the OS network stack (when the OS provides the
 * ECM interface, e.g. macOS AppleUserECM) or over a userspace CDC-ECM + lwIP
 * bridge (when it does not, e.g. Linux without auto-config).
 */

import { DiscoveryError } from '../../errors.js'
import { noopLogger } from '../../logger.js'
import type { VendorPlugin } from '../../protocols/adapter.js'
import { ALCATEL_VID, MOBILEBROADBAND_PID } from './usb-ids.js'

const DEFAULT_GATEWAY_IP = '192.168.1.1'

export const alcatelPlugin: VendorPlugin = {
  vendorId: 'alcatel',
  name: 'Alcatel',

  async discoverAdapters(transport, _profile, _model, opts) {
    const log = opts?.logger ?? noopLogger

    if (transport.type !== 'http') {
      // Alcatel devices are HTTP-only (CDC-ECM, no AT serial ports)
      return { adapters: [] }
    }

    const { EcmTransport } = await import('../../transport/ecm/index.js')
    const { JrdAdapter } = await import('./protocols/jrd/adapter.js')
    const { JrdHttpClient, JrdUsbClient } = await import('./protocols/jrd/client.js')

    const gatewayIp = new URL(transport.url).hostname || DEFAULT_GATEWAY_IP
    const childLog = log.child({ adapter: 'jrd' })

    // Primary: OS network stack. When the OS already gives us IP connectivity to
    // the device (macOS binds AppleUserECM to the CDC-ECM interface; Linux may
    // configure it via NetworkManager), talk plain HTTP over it. This avoids a
    // libusb interface claim that macOS's own ECM driver both refuses
    // (LIBUSB_ERROR_ACCESS) and is disrupted by. Requires the interface to hold
    // an IP on the gateway subnet -- the device's DHCP is unreliable, so this may
    // be a manual assignment (see vendor/alcatel/README.md).
    const httpClient = new JrdHttpClient(transport.url)
    try {
      await httpClient.call('GetSystemInfo') // probe
      log.info('JRD API reachable via OS HTTP stack', { gateway: gatewayIp })
      return { adapters: [new JrdAdapter(httpClient, childLog)] }
    } catch (httpErr: unknown) {
      httpClient.destroy()
      log.info('OS HTTP path unavailable, trying userspace ECM bridge', {
        error: httpErr instanceof Error ? httpErr.message : String(httpErr),
      })
    }

    // Fallback: userspace ECM bridge. Claims the USB interfaces via libusb,
    // exchanges raw Ethernet frames, runs lwIP for TCP/IP -- no OS network config
    // needed. This is the path where the OS provides no usable interface for the
    // device (e.g. Linux without auto-config, or RNDIS which macOS ignores).
    const ecm = new EcmTransport({
      vendorId: ALCATEL_VID,
      productId: MOBILEBROADBAND_PID,
      gatewayIp,
    })
    try {
      await ecm.open()
      const usbClient = new JrdUsbClient(ecm)
      await usbClient.call('GetSystemInfo') // probe
      log.info('JRD API reachable via ECM bridge', { gateway: ecm.gatewayIp })
      return { adapters: [new JrdAdapter(usbClient, childLog)] }
    } catch (ecmErr: unknown) {
      try {
        await ecm.close()
      } catch {
        // ECM never fully opened; nothing to clean up.
      }
      throw new DiscoveryError(
        `Alcatel JRD API unreachable at ${gatewayIp}. Neither the OS network path nor the ` +
          'userspace ECM bridge could reach the device. On macOS the ECM bridge is blocked ' +
          "because the OS holds the interface -- give the device's USB interface an IP on the " +
          'gateway subnet (e.g. 192.168.1.100/24) and retry.',
        { cause: ecmErr },
      )
    }
  },
}
