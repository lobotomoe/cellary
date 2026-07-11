/**
 * 3GPP CME and CMS error code lookup tables.
 *
 * When a modem uses numeric error reporting (CMEE=1), it sends codes like
 * "+CME ERROR: 10". These tables resolve numeric codes to human-readable
 * messages per 3GPP TS 27.007 (CME) and TS 27.005 (CMS).
 */

/** 3GPP TS 27.007 -- CME error codes */
const CME_CODES: Readonly<Record<number, string>> = {
  0: 'Phone failure',
  1: 'No connection to phone',
  2: 'Phone adapter link reserved',
  3: 'Operation not allowed',
  4: 'Operation not supported',
  5: 'PH-SIM PIN required',
  6: 'PH-FSIM PIN required',
  7: 'PH-FSIM PUK required',
  10: 'SIM not inserted',
  11: 'SIM PIN required',
  12: 'SIM PUK required',
  13: 'SIM failure',
  14: 'SIM busy',
  15: 'SIM wrong',
  16: 'Incorrect password',
  17: 'SIM PIN2 required',
  18: 'SIM PUK2 required',
  20: 'Memory full',
  21: 'Invalid index',
  22: 'Not found',
  23: 'Memory failure',
  24: 'Text string too long',
  25: 'Invalid characters in text string',
  26: 'Dial string too long',
  27: 'Invalid characters in dial string',
  30: 'No network service',
  31: 'Network timeout',
  32: 'Network not allowed, emergency calls only',
  40: 'Network personalization PIN required',
  50: 'Operation not supported by firmware',
  100: 'Unknown error',
  111: 'PLMN not allowed',
  112: 'Location area not allowed',
  113: 'Roaming not allowed in this location area',
}

/** 3GPP TS 27.005 -- CMS error codes */
const CMS_CODES: Readonly<Record<number, string>> = {
  1: 'Unassigned number',
  8: 'Operator determined barring',
  10: 'Call barred',
  21: 'Short message transfer rejected',
  27: 'Destination out of service',
  28: 'Unidentified subscriber',
  29: 'Facility rejected',
  30: 'Unknown subscriber',
  38: 'Network out of order',
  41: 'Temporary failure',
  42: 'Congestion',
  47: 'Resources unavailable',
  50: 'Requested facility not subscribed',
  69: 'Requested facility not implemented',
  81: 'Invalid short message transfer reference value',
  95: 'Semantically incorrect message',
  96: 'Invalid mandatory information',
  97: 'Message type non-existent',
  111: 'Protocol error',
  127: 'Interworking error',
  // GSM-specific (300+)
  300: 'ME failure',
  301: 'SMS service of ME reserved',
  302: 'Operation not allowed',
  303: 'Operation not supported',
  304: 'Invalid PDU mode parameter',
  305: 'Invalid text mode parameter',
  310: 'SIM not inserted',
  311: 'SIM PIN required',
  312: 'PH-SIM PIN required',
  313: 'SIM failure',
  314: 'SIM busy',
  315: 'SIM wrong',
  316: 'SIM PUK required',
  317: 'SIM PIN2 required',
  318: 'SIM PUK2 required',
  320: 'Memory failure',
  321: 'Invalid memory index',
  322: 'Memory full',
  330: 'SMSC address unknown',
  331: 'No network service',
  332: 'Network timeout',
  340: 'No CNMA acknowledgement expected',
  500: 'Unknown error',
}

/** Resolve a numeric CME error code to a human-readable message. */
export function cmeMessage(code: number): string | undefined {
  return CME_CODES[code]
}

/** Resolve a numeric CMS error code to a human-readable message. */
export function cmsMessage(code: number): string | undefined {
  return CMS_CODES[code]
}
