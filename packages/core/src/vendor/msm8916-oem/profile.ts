import type { DeviceProfile } from '../../types.js'

/**
 * MSM8916 OEM modem profile.
 *
 * For MSM8916/MDM9207-based 4G USB dongles (TianJie, UFI, UZ801, etc.)
 * running Android internally with AT modem exposed via serial_smd.
 *
 * Key differences from generic 3GPP:
 * - AT+CFUN=1 required early — fresh USB sessions start with SIM state 255
 * - AT+CMEE=2 for verbose error codes (more useful for Qualcomm quirks)
 * - Qualcomm-specific vendor URCs ($QCSQ, ^SYSINFO, etc.)
 * - AT+CLAC needs 30s+ (100+ commands in response)
 *
 * Tested with: TianJie U800-3 (UZ801 v3.0, FW UZ801_V3.0_21_V01R01B10).
 */
export const msm8916OemProfile: DeviceProfile = {
  vendorId: 'msm8916-oem',
  name: 'MSM8916 OEM',

  at: {
    initCommands: [
      // Standard 3GPP
      'ATE0', // Disable echo
      'AT+CFUN=1', // Full functionality — MUST be early, fresh sessions get SIM state 255 without it
      'AT+CMEE=2', // Verbose CME error codes (Qualcomm returns useful text)
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

      // Qualcomm vendor URCs
      '$QCSQ', // Signal quality (RSSI, RSRQ, ?, ?, RSRP)
      '$QCSIMSTAT', // SIM status change
      '$QCRSRP', // Reference signal received power
      '$QCRSRQ', // Reference signal received quality
      '^SYSINFO', // System info change (Qualcomm/Huawei-style, present on some MiFi firmware)
    ],

    commandTimeouts: {
      // Standard
      ATD: 60_000,
      'AT+COPS=?': 120_000, // Operator scan (60s observed on this hardware)
      'AT+COPS=': 90_000,
      'AT+CMGS': 30_000,
      'AT+CUSD': 30_000,
      'AT+CGACT': 60_000,
      'AT+CFUN': 15_000,
      'AT+CPIN': 10_000,

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

      // Qualcomm-specific
      'AT+CLAC': 35_000, // 100+ commands in response, needs 30s+
    },
  },
}
