import type { EnhancedSignalData, TrafficQueryResult } from '../../protocols/at/types.js'
import type { DeviceProfile } from '../../types.js'

import { huaweiStkConfig } from './stk-config.js'

// ── AT^HCSQ parser ──────────────────────────────────────────────────────────
//
// ^HCSQ: "LTE",<rssi>,<rsrp>,<sinr>,<rsrq>
// ^HCSQ: "WCDMA",<rssi>,<rscp>,<ecio>
// ^HCSQ: "GSM",<rssi>
//
// All values are index-based; 255 = unknown/not detectable.
// Conversion formulas from Huawei AT Command Interface Specification.

const HCSQ_REGEX = /\^HCSQ:\s*"([^"]+)"(?:,(.+))?/
const HCSQ_UNKNOWN = 255

const TECH_MAP: Record<string, string> = {
  LTE: 'LTE',
  WCDMA: '3G',
  GSM: 'GSM',
}

function parseHcsqResponse(lines: readonly string[]): EnhancedSignalData {
  for (const line of lines) {
    const match = HCSQ_REGEX.exec(line)
    if (match === null) continue

    const [, tech, valuesStr] = match
    if (tech === undefined) continue
    const technology = TECH_MAP[tech] ?? tech

    if (valuesStr === undefined) return { technology }
    const values = valuesStr.split(',').map((v) => Number.parseInt(v.trim(), 10))

    if (tech === 'LTE') {
      const [rssiIdx, rsrpIdx, sinrIdx, rsrqIdx] = values
      return {
        technology,
        rssi: rssiIdx !== undefined && rssiIdx !== HCSQ_UNKNOWN ? -120 + rssiIdx : undefined,
        rsrp: rsrpIdx !== undefined && rsrpIdx !== HCSQ_UNKNOWN ? -140 + rsrpIdx : undefined,
        sinr:
          sinrIdx !== undefined && sinrIdx !== HCSQ_UNKNOWN
            ? Math.round((-20 + sinrIdx * 0.2) * 10) / 10
            : undefined,
        rsrq:
          rsrqIdx !== undefined && rsrqIdx !== HCSQ_UNKNOWN
            ? Math.round((-19.5 + rsrqIdx * 0.5) * 10) / 10
            : undefined,
      }
    }

    // WCDMA and GSM: first value is always RSSI
    const [basicRssi] = values
    return {
      technology,
      rssi: basicRssi !== undefined && basicRssi !== HCSQ_UNKNOWN ? -120 + basicRssi : undefined,
    }
  }

  return {}
}

// ── AT^DSFLOWQRY parser ──────────────────────────────────────────────────────
//
// ^DSFLOWQRY:<last_time>,<last_tx>,<last_rx>,<total_time>,<total_tx>,<total_rx>
//
// All values are uppercase hex with fixed widths:
// - time fields: 8 hex digits (seconds)
// - traffic fields: 16 hex digits (bytes)
//
// "last" = current active session (or most recent completed session).
// "total" = accumulated since last AT^DSFLOWCLR (or factory reset).

const DSFLOWQRY_REGEX =
  /\^DSFLOWQRY:\s*([0-9A-Fa-f]+),([0-9A-Fa-f]+),([0-9A-Fa-f]+),([0-9A-Fa-f]+),([0-9A-Fa-f]+),([0-9A-Fa-f]+)/

function parseDsflowqryResponse(lines: readonly string[]): TrafficQueryResult {
  for (const line of lines) {
    const match = DSFLOWQRY_REGEX.exec(line)
    if (match === null) continue

    const [, lastTime, lastTx, lastRx, totalTime, totalTx, totalRx] = match
    if (
      lastTime === undefined ||
      lastTx === undefined ||
      lastRx === undefined ||
      totalTime === undefined ||
      totalTx === undefined ||
      totalRx === undefined
    ) {
      continue
    }

    return {
      session: {
        durationSeconds: Number.parseInt(lastTime, 16),
        uploadBytes: Number.parseInt(lastTx, 16),
        downloadBytes: Number.parseInt(lastRx, 16),
      },
      total: {
        durationSeconds: Number.parseInt(totalTime, 16),
        uploadBytes: Number.parseInt(totalTx, 16),
        downloadBytes: Number.parseInt(totalRx, 16),
      },
    }
  }

  throw new Error('AT^DSFLOWQRY returned no parseable data')
}

/**
 * Huawei modem profile.
 *
 * Extends the standard 3GPP command set with Huawei-specific
 * vendor commands (^ prefix) and URC handling.
 *
 * Tested with: E3372 (Stick mode), E3531, E8372.
 * Should work with most Huawei USB modems.
 */
export const huaweiProfile: DeviceProfile = {
  vendorId: 'huawei',
  name: 'Huawei',

  at: {
    initCommands: [
      // Standard 3GPP
      'ATE1', // Enable echo — delimits each command's response for post-timeout resync
      'AT+CMEE=1', // Enable numeric CME error codes
      'AT+CMGF=0', // PDU mode for SMS
      'AT+CNMI=2,1,0,0,0', // Route new SMS as +CMTI URCs
      'AT+CREG=2', // CS registration URCs with extended format (LAC, CellID, AcT)
      'AT+CGREG=1', // GPRS registration URCs
      'AT+CLIP=1', // Calling line identification

      // Huawei-specific
      'AT^CURC=0', // Disable unsolicited Huawei URCs (^DSFLOWRPT floods the port)
      'AT^USSDMODE=0', // Plain text USSD (default is PDU, which causes CME ERROR 304)
      'AT^DSCI=1', // Enable call status indication URCs (^DSCI reports caller ID even on data-only devices)
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

      // Huawei vendor URCs
      '^RSSI', // Signal strength change
      '^HCSQ', // Signal quality (LTE-aware: rssi, rsrp, sinr, rsrq)
      '^MODE', // Network mode change (unreliable for LTE, prefer ^HCSQ)
      '^DSFLOWRPT', // Data flow report (suppressed by AT^CURC=0)
      '^BOOT', // Device boot notification
      '^SIMST', // SIM card status change
      '^SRVST', // Service status change
      '^CEND', // Call end with cause code
      '^ORIG', // Outgoing call originated
      '^CONF', // Network confirmed call (remote ringing)
      '^CONN', // Call connected
      '^DSCI', // Call status indication (direction, state, caller number)

      // SIM Toolkit
      '^STIN', // STK proactive command indication
    ],

    commandTimeouts: {
      // Slow operations (network, radio, SMS)
      ATD: 60_000,
      'AT+COPS=?': 120_000,
      'AT+COPS=': 90_000,
      'AT+CMGS': 30_000,
      'AT+CUSD': 30_000,
      'AT+CGACT': 60_000,
      'AT+CFUN': 15_000,
      'AT+CPIN': 10_000,

      // Init commands — should respond in <1s on any working modem.
      // Short timeouts so stuck Balong firmware (without SIM) triggers
      // the cascade detector quickly instead of waiting 10s per command.
      // NOTE: AT+CFUN intentionally keeps its 15s timeout above (radio init with SIM).
      ATE: 3_000,
      'AT+CMEE': 3_000,
      'AT+CMGF': 3_000,
      'AT+CNMI': 5_000,
      'AT+CREG=': 5_000,
      'AT+CGREG=': 5_000,
      'AT+CLIP': 3_000,
      'AT^CURC': 3_000,
      'AT^USSDMODE': 3_000,
      'AT^DSCI': 3_000,

      // Instant-response query commands — fail fast on stuck firmware.
      'AT+CGMI': 3_000,
      'AT+CGMM': 3_000,
      'AT+CGMR': 3_000,
      'AT+CGSN': 3_000,
      'AT+CSQ': 5_000,
      'AT^HCSQ': 5_000,
      'AT+CREG?': 5_000,
      'AT+CGREG?': 5_000,
      'AT+COPS?': 5_000,

      // Huawei-specific
      'AT^DSFLOWQRY': 5_000, // Traffic statistics query
      'AT^SYSCFGEX': 30_000, // Network mode configuration

      // SIM Toolkit
      'AT^STSF': 10_000, // STK enable/disable
      'AT^STGI': 10_000, // STK get info
      'AT^STGR': 10_000, // STK give response
    },

    commands: {
      // Huawei uses vendor-specific AT^ICCID? instead of standard AT+CCID.
      // Response format: ^ICCID: <iccid_bcd>
      // See: Huawei ME909u-521 AT Command Interface Specification
      iccid: 'AT^ICCID?',

      // Route PCM audio through DIAG port before each voice call.
      // Must be sent before every ATD -- defaults to non-working PCVOICE port otherwise.
      // See: https://wiki.tadeu.org/misc:huaweii-voice
      voiceSetup: 'AT^DDSETEX=2',

      // Chip temperature: ^CHIPTEMP: battery,pa,pmu,cpu,threshold
      // All values in degrees Celsius except threshold (10000 = disabled)
      chipTemp: 'AT^CHIPTEMP?',

      // Hardware revision: ^HWVER: "CL2E3372HM Ver.A" (board/revision identifier)
      hardwareVersion: 'AT^HWVER',

      // SIM Toolkit commands (Huawei vendor-specific)
      stkEnable: 'AT^STSF=1',
      stkIndication: '^STIN',
      stkGetInfo: 'AT^STGI',
      stkRespond: 'AT^STGR',
    },

    // Vendor-specific CLAC commands for capability discovery
    capabilityChecks: {
      iccid: ['^ICCID', '^SCID'],
      stk: ['^STSF', '^STGI'],
    },

    signal: {
      command: 'AT^HCSQ?',
      parse: parseHcsqResponse,
    },

    traffic: {
      command: 'AT^DSFLOWQRY',
      parse: parseDsflowqryResponse,
    },

    stk: huaweiStkConfig,
  },
}
