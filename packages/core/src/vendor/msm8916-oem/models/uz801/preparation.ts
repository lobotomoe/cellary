/**
 * UZ801 / MSM8916 preparation profile.
 *
 * USB composition state machine (from device init scripts):
 *   persist.sys.usb.config = "rndis"                   -> PID 0xf00e (consumer)
 *   persist.sys.usb.config = "rndis,serial_smd,diag,adb" -> PID 0x90b6 (debug)
 *   persist.sys.usb.config = <anything else>            -> forced to "rndis" on boot
 *
 * Factory default for MSM8916: "rndis,serial_smd,diag,adb" (PID 0x90b6).
 * Device only reaches PID 0xf00e if something explicitly writes "rndis" to persist.
 *
 * Health checks are empty because they depend on which protocol adapters
 * are available (AT vs HTTP). The preparation runner will add generic
 * checks once protocol-aware profile resolution is implemented.
 */

import type { PrepProfile } from '../../../../preparation/types.js'
import { uz801ThermalCap } from './thermal-remediation.js'

export const uz801PrepProfile: PrepProfile = {
  name: 'UZ801 MSM8916 4G Stick',
  checks: [],
  remediations: [uz801ThermalCap],
  limitations: [
    {
      scope: 'thermal',
      severity: 'critical',
      description:
        'Hardware thermal shutdown every 8-20s at stock CPU speed (1190 MHz). ' +
        'MSM8916 SoC has no thermal pads to RF shield on v3.0 boards. ' +
        'Without CPU cap, device enters boot loop -- USB-enumerates for ~8s, ' +
        'then drops off bus for ~18s, repeating indefinitely.',
      workaround:
        'Via ADB: echo 200000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq ' +
        'and stop mpdecision. Does NOT persist across reboots -- must be reapplied ' +
        'within the ~8s ADB window on each boot cycle. ' +
        'Hardware fix: add 0.5mm thermal pads between SoC and RF shield.',
    },
    {
      scope: 'firmware',
      severity: 'info',
      description:
        'tsens thermal sensors broken on stock firmware (report 0.069C constant). ' +
        'Only pm8916_tz (PMIC) provides real temperature data.',
    },
    {
      scope: 'usb-composition',
      severity: 'warning',
      description:
        'USB PID is controlled by Android property persist.sys.usb.config (NVM). ' +
        'Only two values survive reboot: "rndis" (PID 0xf00e) and ' +
        '"rndis,serial_smd,diag,adb" (PID 0x90b6). Any other value is ' +
        'force-reset to "rndis" by initmifiservice.sh on boot_completed. ' +
        'PID 0x9024 (rndis,adb) is transient -- lost on next reboot.',
    },
    {
      scope: 'at',
      severity: 'warning',
      description:
        'AT session requires initialization in a single USB session. ' +
        'Fresh connections cause most commands to fail (SIM state 255). ' +
        'Must send CFUN=1, CMEE=2, and wait ~10s for SIM/network init. ' +
        'AT+CGMM/CGMR/CGMI timeout (use ATI). AT+COMMAT/SSID hang.',
    },
    {
      scope: 'at',
      severity: 'critical',
      description:
        'AT+USB? writes persist.sys.usb.config="rndis" (NVM), immediately ' +
        're-enumerating at PID 0xf00e. Destroys AT and ADB access. ' +
        'HTTP API at PID 0xf00e often unresponsive (Jetty accepts TCP but ' +
        'returns empty body). Recovery: physical replug + thermal cooldown, ' +
        'or ADB setprop if TCP ADB was previously configured.',
    },
    {
      scope: 'http',
      severity: 'warning',
      description:
        'PID 0xf00e HTTP server (Jetty on port 80): RNDIS transport works, ' +
        'TCP connects succeed (SYN-ACK received), but HTTP responses may be ' +
        'empty. Particularly unreliable after AT+USB? corruption. ' +
        'RNDIS bridge is at 192.168.100.1 (br0 with rndis0).',
    },
  ],
}
