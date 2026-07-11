/**
 * 3GPP lookup tables shared across CLI commands and decoders.
 *
 * Single source of truth for registration status codes, access technologies,
 * SIM states, and other standard 3GPP constants used in multiple places.
 *
 * References:
 * - Registration status: 3GPP TS 27.007 section 7.2
 * - Access technology:   3GPP TS 27.007 section 7.2
 * - SIM/CPIN states:     3GPP TS 27.007 section 8.3
 * - Phone activity:      3GPP TS 27.007 section 8.34
 * - MS class:            3GPP TS 27.007 section 10.1.16
 * - Call forwarding:     3GPP TS 27.007 section 7.11
 */

// +CREG / +CGREG / +CEREG stat values
export const REG_STATUS: Record<string, string> = {
  '0': 'Not registered',
  '1': 'Home',
  '2': 'Searching',
  '3': 'Denied',
  '4': 'Unknown',
  '5': 'Roaming',
}

// +CREG / +CGREG / +CEREG AcT values
export const ACCESS_TECH: Record<string, string> = {
  '0': 'GSM',
  '1': 'GSM Compact',
  '2': '3G (UTRAN)',
  '3': 'EDGE',
  '4': '3G HSDPA',
  '5': '3G HSUPA',
  '6': '3G HSPA+',
  '7': 'LTE',
}

// +CPIN response states
export const CPIN_STATES: Record<string, string> = {
  READY: 'SIM ready',
  'SIM PIN': 'PIN required',
  'SIM PUK': 'PUK required (SIM blocked!)',
  'SIM PIN2': 'PIN2 required',
  'SIM PUK2': 'PUK2 required',
  'PH-NET PIN': 'Network lock PIN required',
}

// +CPAS phone activity status
export const PHONE_ACTIVITY: Record<string, string> = {
  '0': 'ready',
  '2': 'unknown',
  '3': 'ringing',
  '4': 'call in progress',
  '5': 'asleep',
}

// +CGCLASS mobile station class
export const MS_CLASS: Record<string, string> = {
  A: 'class A (CS+PS simultaneous)',
  B: 'class B (CS+PS, not simultaneous)',
  CG: 'class C (GPRS/data only)',
  CC: 'class C (CS only)',
}

// +CCFC call forwarding reason codes
export const CF_REASON: Record<string, string> = {
  '0': 'unconditional',
  '1': 'busy',
  '2': 'not reachable',
  '3': 'no reply',
}
