/**
 * Alcatel vendor module.
 *
 * Covers Alcatel / TCL USB modems (VID 0x1BBB).
 *
 * Known devices:
 * - Alcatel LINKZONE MW45V (PID 0x0908) — CDC-ECM pocket MiFi with JRD HTTP API
 *
 * Protocol: TCL JRD JSON-RPC over HTTP at /jrd/webapi.
 * No AT serial ports. USB provides Ethernet (CDC-ECM) only.
 * See protocols/jrd/ for the adapter implementation and README.md for API docs.
 */

export { alcatelPlugin } from './plugin.js'
export { alcatelUsbEntry } from './usb-entries.js'
export { ALCATEL_VID, MOBILEBROADBAND_PID } from './usb-ids.js'
