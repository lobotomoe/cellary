/**
 * ZTE vendor plugin.
 *
 * Discovers protocol adapters for ZTE USB modems.
 * Currently AT-only — ZTE modems expose standard 3GPP AT interface
 * with some vendor-specific extensions (+ZPAS, +ZRSSI, AT+ICCID).
 */

import { noopLogger } from '../../logger.js'
import type { VendorPlugin } from '../../protocols/adapter.js'

export const ztePlugin: VendorPlugin = {
  vendorId: 'zte',
  name: 'ZTE',

  async discoverAdapters(transport, profile, _model, opts) {
    const log = opts?.logger ?? noopLogger

    if (transport.type === 'http') {
      throw new Error('ZTE modems do not expose an HTTP API')
    }

    const { AtAdapter } = await import('../../protocols/at/index.js')
    log.info('Connecting AT adapter', { transport: transport.type })
    const atAdapter = await AtAdapter.connect(transport, profile, opts ?? {}, _model)
    return { adapters: [atAdapter] }
  },
}
