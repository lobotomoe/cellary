/**
 * Alcatel/TCL JRD JSON-RPC HTTP API.
 *
 * Protocol used by Alcatel LinkZone (MW45V) and other TCL-manufactured
 * mobile hotspots. JSON-RPC endpoint at /jrd/webapi?api=<MethodName>.
 *
 * See README.md (parent vendor directory) for full API documentation.
 */

import type { ModemDriver } from '../../../../types.js'

/**
 * Driver identifier for the JRD HTTP API.
 * Registered in the USB database so the generic discovery layer
 * never needs to reference the 'alcatel-jrd' string directly.
 */
export const JRD_DRIVER: ModemDriver = { kind: 'vendor', api: 'alcatel-jrd' }

export { JrdAdapter } from './adapter.js'
export { JrdApiError } from './client.js'
