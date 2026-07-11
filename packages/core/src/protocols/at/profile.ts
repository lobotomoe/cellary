import type { DeviceProfile } from './types.js'

/**
 * Generic 3GPP-compliant modem profile.
 *
 * Works with any modem that implements the standard AT command set
 * per 3GPP TS 27.007 and TS 27.005. This is the default profile
 * used when no vendor-specific profile is provided.
 */
export const genericProfile: DeviceProfile = {
  name: 'Generic 3GPP',

  at: {
    initCommands: [
      'ATE0', // Disable echo — critical for parser sanity
      'AT+CMEE=1', // Enable numeric CME error codes
      'AT+CMGF=0', // PDU mode for SMS (more reliable, supports multipart)
      'AT+CNMI=2,1,0,0,0', // Route new SMS notifications as +CMTI URCs
      'AT+CREG=1', // Enable network registration change URCs
      'AT+CGREG=1', // Enable GPRS registration change URCs
      'AT+CEREG=1', // Enable EPS/LTE registration change URCs
      'AT+CLIP=1', // Enable calling line identification on incoming calls
      'AT+CRC=1', // Extended format incoming call type (+CRING: VOICE)
      'AT+CSSN=1,1', // Enable supplementary service notifications (CSSI + CSSU)
      'AT+CMER=3,0,0,1,0', // Enable indicator change URCs (+CIEV)
    ],

    urcPrefixes: [
      // SMS
      '+CMTI', // New SMS received (index notification)
      '+CMT', // New SMS received (full PDU delivered)
      '+CDSI', // New status report received (index)
      '+CDS', // New status report received (full)

      // Calls
      'RING', // Incoming call
      '+CRING', // Extended incoming call type (AT+CRC=1)
      '+CLIP', // Calling line identification
      'NO CARRIER', // Call ended / connection dropped
      'BUSY', // Remote party busy

      // Network registration
      '+CREG', // CS (circuit-switched) registration
      '+CGREG', // PS (packet-switched / GPRS) registration
      '+CEREG', // EPS (LTE) registration

      // Supplementary service notifications
      '+CSSI', // MO SS notification (forwarding active, barred, etc.)
      '+CSSU', // MT SS notification (forwarded call, held, etc.)
      '+CNAP', // Calling name presentation

      // Indicators
      '+CIEV', // Indicator change (battery, signal, service, etc.)

      // Timezone
      '+CTZV', // Time zone change (basic, AT+CTZR=1)
      '+CTZE', // Time zone change (extended, AT+CTZR=2)

      // Packet domain
      '+CGEV', // Packet domain event (AT+CGEREP)

      // Power management
      '+CEDRXP', // eDRX parameter change (AT+CEDRXS=2)
      '+CSCON', // Signalling connection status (AT+CSCON=1)

      // Other
      '+CUSD', // USSD response
      '+CPIN', // SIM state changed
    ],

    commandTimeouts: {
      // Slow operations (network, radio, SMS)
      ATD: 60_000, // Dialing
      'AT+COPS=?': 120_000, // Operator scan (notoriously slow)
      'AT+COPS=': 90_000, // Manual operator selection
      'AT+CMGS': 30_000, // SMS send
      'AT+CUSD': 30_000, // USSD
      'AT+CGACT': 60_000, // PDP context activation
      'AT+CFUN': 15_000, // Functionality mode (may restart radio)
      'AT+CPIN': 10_000, // PIN entry

      // Init commands — should respond in <1s on any working modem.
      // Short timeouts so the cascade detector triggers quickly on stuck firmware.
      ATE: 3_000,
      'AT+CMEE': 3_000,
      'AT+CMGF': 3_000,
      'AT+CNMI': 5_000,
      'AT+CREG=': 5_000,
      'AT+CGREG=': 5_000,
      'AT+CEREG=': 5_000,
      'AT+CLIP': 3_000,
      'AT+CRC': 3_000,
      'AT+CSSN': 3_000,
      'AT+CMER': 3_000,

      // Instant-response query commands — fail fast on stuck firmware.
      'AT+CGMI': 3_000, // Manufacturer ID (device-level, no SIM needed per 3GPP)
      'AT+CGMM': 3_000, // Model ID
      'AT+CGMR': 3_000, // Revision
      'AT+CGSN': 3_000, // IMEI / serial number
      'AT+CSQ': 5_000, // Signal quality
      'AT+CREG?': 5_000, // CS registration query (not AT+CREG= which sets mode)
      'AT+CGREG?': 5_000, // GPRS registration query
      'AT+CEREG?': 5_000, // EPS/LTE registration query
      'AT+CESQ': 5_000, // Extended signal quality
      'AT+COPN': 10_000, // Operator names (can be large)
      'AT+CPOL': 5_000, // Preferred operator list
      'AT+COPS?': 5_000, // Current operator query (not scan or selection)

      // SIM management
      'AT+CPINR': 5_000, // Remaining PIN retries
      'AT+CLCK': 15_000, // Facility lock (network round-trip for barring)
      'AT+CPWD': 5_000, // Change password
      'AT+CSCS': 3_000, // Character set query/set

      // Call supplementary services (network round-trips)
      'AT+CLIR': 5_000, // CLIR query/set
      'AT+CCFC': 15_000, // Call forwarding (network round-trip)
      'AT+CCWA': 15_000, // Call waiting (network round-trip)
      'AT+CHLD': 5_000, // Call hold/conference

      // Radio & activity
      'AT+CPAS': 3_000, // Phone activity status
      'AT+WS46': 5_000, // Wireless service selection

      // Indicators
      'AT+CIND': 5_000, // Indicator read/test

      // Clock & timezone
      'AT+CCLK': 3_000, // Real-time clock read/set
      'AT+CTZU': 3_000, // Automatic timezone update
      'AT+CTZR': 3_000, // Timezone reporting

      // Phonebook
      'AT+CPBS': 3_000, // Select phonebook storage
      'AT+CPBR': 5_000, // Read phonebook entries
      'AT+CPBF': 5_000, // Find phonebook entries
      'AT+CPBW': 5_000, // Write phonebook entry

      // Data connection
      'AT+CGCONTRDP': 5_000, // PDP context dynamic params
      'AT+CGAUTH': 5_000, // PDP context authentication
      'AT+CGEREP': 3_000, // Packet domain event reporting
      'AT+CGCMOD': 60_000, // Modify active PDP context (network round-trip)

      // Power management (IoT)
      'AT+CPSMS': 5_000, // Power saving mode config
      'AT+CEDRXS': 5_000, // eDRX setting
      'AT+CEDRXRDP': 5_000, // eDRX read dynamic params
      'AT+CSCON': 3_000, // Signalling connection status

      // Battery
      'AT+CBC': 3_000, // Battery charge status

      // EPS QoS & UE mode
      'AT+CGEQOS': 5_000, // EPS QoS params
      'AT+CGEQOSRDP': 5_000, // Negotiated EPS QoS
      'AT+CEMODE': 5_000, // UE mode of operation
    },
  },
}
