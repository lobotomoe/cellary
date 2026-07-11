/**
 * UZ801 / MSM8916 4G USB stick.
 *
 * Generic Chinese 4G USB WiFi dongle based on Qualcomm MSM8916 SoC.
 * Sold under many brands: TianJie, UFI, and various no-name AliExpress sellers.
 * Board name "UZ801" is printed on the PCB (versions: v2.0, v3.0, v3.2).
 *
 * Runs Android internally, exposes RNDIS over USB, managed via HTTP API.
 * Has well-documented thermal issues due to missing thermal interface material
 * between the SoC and RF shield on most board revisions (especially v3.0).
 *
 * ## USB Composition State Machine
 *
 * The USB PID is determined by Android property `persist.sys.usb.config`,
 * which is stored on the `/persist` partition (survives reboots).
 *
 * Boot sequence (from init scripts on the device):
 *   1. `init.qcom.usb.sh` -- if persist is empty, sets factory default
 *      for MSM8916: `rndis,serial_smd,diag,adb` (PID 0x90b6)
 *   2. `init.usb.rc` -- copies `persist.sys.usb.config` to `sys.usb.config`
 *   3. `init.qcom.usb.rc` -- property trigger matches `sys.usb.config`,
 *      writes gadget functions + PID to sysfs, enables USB
 *   4. `initmifiservice.sh` (on boot_completed) -- validates config:
 *      - `rndis,serial_smd,diag,adb` -- keep (debug mode)
 *      - `rndis` -- keep (consumer mode)
 *      - anything else -- FORCE RESET to `rndis` (PID 0xf00e)!
 *
 * Property-to-PID mapping (from init.qcom.usb.rc):
 *   persist.sys.usb.config             | sys.usb.config expansion        | PID
 *   -----------------------------------|----------------------------------|-------
 *   `rndis`                            | `rndis,none` (via config.extra)  | 0xf00e
 *   `rndis,adb`                        | `rndis,none,adb` (via extra)     | 0x9024
 *   `rndis,serial_smd,diag,adb`        | direct match                     | 0x90b6
 *
 * IMPORTANT: PID 0x9024 is transient -- `initmifiservice.sh` does not
 * recognize `rndis,adb` as valid, so the next reboot forces PID 0xf00e.
 * Only `rndis` and `rndis,serial_smd,diag,adb` survive reboots.
 *
 * Key property: `persist.sys.usb.config.extra` = `none` (on this firmware).
 * The `rndis` trigger expands to `rndis,${config.extra}` = `rndis,none`.
 *
 * How composition changes happen:
 *   - AT+USB? command: writes `persist.sys.usb.config=rndis`, device
 *     re-enumerates at PID 0xf00e. Persists across reboots.
 *   - HTTP API funcNo=2001: likely writes persist config, triggers reboot.
 *   - ADB setprop: `setprop persist.sys.usb.config <value>` + reboot.
 *
 * Other init.qcom.usb.rc entries: `debug.composition.type=c2d` is set
 * but unused by the MiFi firmware. ~60 Qualcomm compositions are defined
 * in the RC file (diag, mtp, ptp, etc.) but only 3 PIDs are relevant
 * for this device.
 *
 * `initmifiservice.sh` also:
 *   - Sets up RNDIS bridge: `br0` at 192.168.100.1 with `rndis0`
 *   - Starts `modem_at` (the AT command handler for /dev/smd11)
 *   - Sets iptables TTL=64 on rmnet0 (carrier tethering detection evasion)
 */

import type { ModelInfo } from '../../../../types.js'
import { QUALCOMM_VID } from '../../usb-ids.js'
import { uz801PrepProfile } from './preparation.js'

export { UZ801_THERMAL } from './constants.js'

// ── USB Product IDs ──────────────────────────────────────────────────────────

/**
 * RNDIS-only USB composition.
 * persist.sys.usb.config = "rndis" -> expanded to "rndis,none" -> PID 0xf00e.
 * Single RNDIS interface, no ADB, no serial. HTTP API at 192.168.100.1.
 *
 * This is NOT the factory default (factory is 0x90b6). This PID appears when:
 *   - AT+USB? command resets persist config to "rndis"
 *   - initmifiservice.sh forces reset on unrecognized config values
 *
 * HTTP API (Jetty on port 80) may not respond after AT+USB? corruption --
 * TCP port 80 accepts connections but returns empty responses.
 */
export const UZ801_PID_RNDIS = 0xf00e

/**
 * RNDIS + ADB USB composition.
 * persist.sys.usb.config = "rndis,adb" -> expanded to "rndis,none,adb" -> PID 0x9024.
 *
 * WARNING: This PID is TRANSIENT. initmifiservice.sh does not recognize
 * "rndis,adb" as a valid config. On next reboot, it will be force-reset
 * to "rndis" (PID 0xf00e). Only useful within a single boot session.
 */
export const UZ801_PID_RNDIS_ADB = 0x9024

/**
 * Qualcomm HS-USB Composite: serial_smd + diag + ADB.
 * RNDIS is declared in sys.usb.config but does not function on macOS --
 * the host sees a modem/diag/adb composite with no working network.
 * ADB works after adding 0x05c6 to ~/.android/adb_usb.ini.
 *
 * Interfaces:
 *   0: RNDIS control (class 224/1/3) -- interrupt EP only
 *   1: RNDIS data (class 10/0/0) -- bulk IN/OUT, non-functional on macOS
 *   2: AT modem via serial_smd (class 255/0/0) -- bulk IN 0x83, OUT 0x02, int 0x84
 *   3: DIAG port (class 255/255/255) -- bulk IN 0x85, OUT 0x03
 *   4: ADB (class 255/66/1) -- bulk IN 0x86, OUT 0x04
 *
 * AT modem (interface 2) requires CDC ACM DTR assertion before accepting
 * commands. Use UsbTransport with `assertDtr: true`.
 *
 * CRITICAL: AT session initialization.
 * Opening a fresh USB connection after closing a previous one causes most
 * commands to fail (sim_state=255, everything returns ERROR). The AT adapter
 * MUST send AT+CFUN=1 + AT+CMEE=2 and wait ~10s for SIM/network init in
 * the SAME session. Do not close and reopen between init and commands.
 *
 * Tested AT commands (firmware UZ801_V3.0_21_V01R01B10, deep probe):
 *
 * Working:
 *   Identity:  ATI, AT+CGSN, AT+CFUN
 *   SIM:       AT+CPIN?, AT+CIMI, AT$QCSIMSTAT?, AT$QCSIMAPP?
 *   Signal:    AT+CSQ, AT$QCSQ (5 values: RSSI,RSRQ,?,?,RSRP)
 *   Network:   AT+CREG?, AT+CGREG?, AT+CEREG?, AT+COPS?, AT+COPS=? (60s),
 *              AT$QCSYSMODE, AT^SYSINFO, AT^SYSCONFIG?, AT$QCNSP?
 *   Data:      AT+CGDCONT?, AT+CGACT?, AT+CGPADDR
 *   SMS:       AT+CMGF, AT+CPMS, AT+CMGL, AT+CSCA?
 *   Voice:     AT+CLCC, AT+CVHU?
 *   USSD:      AT+CUSD=? (supported, modes 0-2)
 *   Config:    AT+IPR?, AT+ICF?, AT+IFC?, AT+CSCS?, AT+CNUM
 *   Device:    AT+MAC?, AT+WRSN?, AT+WRIMEI?
 *   Qualcomm:  AT$QCBANDPREF?, AT$QCBANDPREF=?, AT$QCPBMPREF?,
 *              AT$QCPDPP?, AT$QCHCREG?, AT$QCDNSP?, AT$QCDNSS?
 *
 * Timeout (firmware quirks):
 *   AT+CGMM, AT+CGMR, AT+CGMI -- use ATI for model identification
 *   AT+CLAC -- 100+ commands, needs 30s+ timeout
 *   AT+COMMAT?, AT+SSID? -- hang indefinitely, avoid
 *
 * ERROR despite appearing in AT+CLAC:
 *   AT$QCRSRP?, AT$QCRSRQ?, AT+CESQ, AT$QCVOLT?, AT^CARDMODE?
 *
 * Signal format: AT$QCSQ returns "RSSI,RSRQ,?,?,RSRP"
 *   Example: $QCSQ:-59,-6,0,0,-65
 *
 * SMS: PDU mode. SIM 15/15, ME 0/23. SMSC +7921960096400.
 * Bands: WCDMA_I_IMT_2000, WCDMA_VIII_900 active. 46 bands available.
 * Config: 115200 baud, IRA charset, HW flow control (2,2).
 * Device: MAC A08722D987F7, SN 2022080019350.
 */
export const UZ801_PID_MODEM_DIAG_ADB = 0x90b6

/** AT modem interface number on PID 0x90b6 composite. */
export const UZ801_AT_INTERFACE = 2

/**
 * AT commands that must NEVER be sent to the UZ801 modem.
 *
 * AT+USB? writes `persist.sys.usb.config=rndis` to the Android property
 * store (NVM on /persist partition). The device immediately re-enumerates
 * at PID 0xf00e (RNDIS-only), destroying AT and ADB access.
 *
 * Recovery options:
 *   - HTTP API funcNo=2001 (if Jetty is responding -- often it isn't)
 *   - Physical disconnect + wait for thermal cooldown. On some firmware
 *     versions, the device may spontaneously boot to PID 0x90b6 if
 *     init.qcom.usb.sh re-applies the factory default on empty persist.
 *   - ADB `setprop persist.sys.usb.config rndis,serial_smd,diag,adb`
 *     (only if ADB is somehow still reachable, e.g. via TCP/IP)
 */
export const UZ801_BLACKLISTED_COMMANDS = ['AT+USB', 'AT+USB?', 'AT+USB='] as const

// ── Android USB Config Values ────────────────────────────────────────────────

/**
 * Android property values that control USB composition.
 * Written to `persist.sys.usb.config` (NVM, survives reboots).
 *
 * Only two values are recognized by `initmifiservice.sh`:
 *   - USB_CONFIG_RNDIS -> PID 0xf00e (consumer mode, no AT/ADB)
 *   - USB_CONFIG_DEBUG -> PID 0x90b6 (debug mode, AT + DIAG + ADB)
 * Any other value is force-reset to USB_CONFIG_RNDIS on boot.
 */
export const UZ801_USB_CONFIG_RNDIS = 'rndis'
export const UZ801_USB_CONFIG_DEBUG = 'rndis,serial_smd,diag,adb'

/**
 * Qualcomm Emergency Download (EDL) mode.
 * Device entered a failed boot state. Requires Qualcomm QFIL or similar
 * flash tool to recover. Not recoverable via normal USB operations.
 */
export const UZ801_PID_EDL = 0x9008

// ── Hardware variants ────────────────────────────────────────────────────────

/**
 * Known board revisions.
 * All share the same SoC (MSM8916), same firmware, same USB IDs.
 * Differences are in thermal design and component layout.
 */
export const UZ801_BOARD_VERSIONS = ['v2.0', 'v3.0', 'v3.2'] as const
export type Uz801BoardVersion = (typeof UZ801_BOARD_VERSIONS)[number]

/**
 * Known brand names for this hardware.
 * Same PCB and firmware, different plastic shells and product listings.
 */
export const UZ801_BRAND_NAMES = ['TianJie', 'UFI', 'UZ801', 'SP970'] as const

/**
 * Known UFI board variants sharing the MSM8916 platform.
 * Different PCB designs but same SoC, firmware, and USB protocol.
 */
export const UFI_BOARD_VARIANTS = [
  'UFI001B',
  'UFI001C',
  'UZ801-V2.0',
  'UZ801-V3.0',
  'UZ801-V3.2',
  'SP970',
] as const

// ── Model metadata ──────────────────────────────────────────────────────────

/** Per-model metadata for UZ801-based devices. */
export const uz801Model: ModelInfo = {
  name: 'UZ801',
  prepProfile: uz801PrepProfile,
  profilePatches: {
    at: {
      commandTimeouts: {
        'AT+CLAC': 35_000, // 100+ commands, needs 30s+ on this firmware
      },
    },
  },
}

// ── USB identification helper ────────────────────────────────────────────────

/** Check if a USB device is a UZ801/MiFi stick by VID/PID. */
export function isUz801(vendorId: number, productId: number): boolean {
  if (vendorId !== QUALCOMM_VID) return false
  return (
    productId === UZ801_PID_RNDIS ||
    productId === UZ801_PID_RNDIS_ADB ||
    productId === UZ801_PID_MODEM_DIAG_ADB
  )
}
