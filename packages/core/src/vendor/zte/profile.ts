import type { DeviceProfile } from '../../types.js'

/**
 * ZTE modem profile.
 *
 * For ZTE 3G/4G USB modems (MF656, MF190, MF180, etc.).
 * These devices use Qualcomm MSM chipsets with ZTE firmware.
 *
 * Key differences from generic 3GPP:
 * - AT+ICCID for ICCID (not +CCID or +ZGETICCID)
 * - ZTE vendor URCs: +ZPAS (service change), +ZRSSI (signal)
 * - Qualcomm vendor URCs: $QCSIMSTAT, $CREG, $QCSYSMODE
 * - Echo enabled by default — ATE0 is critical
 * - AT+ZSNT for network selection type
 *
 * Tested with: ZTE MF656 (FW BD_MF656V1.0.2B11).
 */
export const zteProfile: DeviceProfile = {
  vendorId: 'zte',
  name: 'ZTE',

  at: {
    initCommands: [
      'ATE0', // Disable echo (enabled by default on ZTE)
      'AT+CMEE=1', // Numeric CME error codes
      'AT+CMGF=0', // PDU mode for SMS
      'AT+CNMI=2,1,0,0,0', // Route new SMS as +CMTI URCs
      'AT+CREG=1', // CS registration URCs
      'AT+CGREG=1', // GPRS registration URCs
      'AT+CLIP=1', // Calling line identification
    ],

    urcPrefixes: [
      // Standard 3GPP
      '+CMTI',
      '+CMT',
      '+CDSI',
      '+CDS',
      'RING',
      '+CLIP',
      'NO CARRIER',
      'BUSY',
      '+CREG',
      '+CGREG',
      '+CEREG',
      '+CUSD',
      '+CPIN',

      // ZTE vendor URCs
      '+ZPAS', // Service status change (e.g. "3G","CS_PS")
      '+ZUSIMR', // SIM status change
      '+ZDONR', // Domestic roaming notification
      '+ZPASR', // Service status URC
      '+ZEND', // Call end

      // Qualcomm vendor URCs (present on ZTE MSM chipsets)
      '$QCSIMSTAT', // SIM status change
      '$CREG', // Qualcomm registration
      '$QCSYSMODE', // System mode change
    ],

    commands: {
      // ZTE MF656 rejects the standard AT+CCID and Huawei's AT^ICCID?.
      // Its vendor command is AT+ICCID, response "ICCID: <value>".
      iccid: 'AT+ICCID',
    },

    commandTimeouts: {
      ATD: 60_000,
      'AT+COPS=?': 120_000, // Operator scan
      'AT+COPS=': 90_000,
      'AT+CMGS': 30_000,
      'AT+CUSD': 30_000,
      'AT+CGACT': 60_000,
      'AT+CFUN': 15_000,
      'AT+CPIN': 10_000,
      'AT+CLAC': 30_000,

      // Init commands — instant-response, short timeout for cascade detection
      ATE: 3_000,
      'AT+CMEE': 3_000,
      'AT+CMGF': 3_000,
      'AT+CNMI': 5_000,
      'AT+CREG=': 5_000,
      'AT+CGREG=': 5_000,
      'AT+CLIP': 3_000,

      // Instant-response query commands — fail fast on stuck firmware
      'AT+CGMI': 3_000,
      'AT+CGMM': 3_000,
      'AT+CGMR': 3_000,
      'AT+CGSN': 3_000,
      'AT+CSQ': 5_000,
      'AT+CREG?': 5_000,
      'AT+CGREG?': 5_000,
      'AT+COPS?': 5_000,
    },
  },
}
