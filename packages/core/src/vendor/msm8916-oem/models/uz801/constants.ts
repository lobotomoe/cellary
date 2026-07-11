/**
 * UZ801 / MSM8916 thermal constants.
 *
 * Kept separate from index.ts (model metadata) and preparation.ts (profile) so
 * the thermal remediation can depend on these values without an import cycle.
 */

/**
 * Thermal characteristics measured on a TianJie U800-3 (UZ801 v3.0 board).
 *
 * The MSM8916 has a hardware thermal protection trip at ~97C on the SoC die.
 * The only externally readable sensor is pm8916_tz (PMIC temperature),
 * which reads ~10-15C below the actual die temperature.
 *
 * tsens_tz_sensor0-4 are broken on stock firmware (report 0.1C constant).
 * bms/battery reports ~22C (ambient, useless for SoC thermal monitoring).
 *
 * At stock settings (1190 MHz, 2 cores), the device thermally reboots
 * every 30-60 seconds under idle load. No sustained operation is possible
 * without hardware modification or aggressive CPU frequency capping.
 */
export const UZ801_THERMAL = {
  /** PMIC temperature at which hardware thermal shutdown typically occurs */
  pmicShutdownThresholdC: 55,
  /** CPU frequency (kHz) that provides best thermal stability */
  stableFrequencyKhz: 200_000,
  /** Available CPU frequencies (kHz) on MSM8916 (confirmed via sysfs) */
  availableFrequenciesKhz: [200_000, 400_000, 533_333, 800_000, 998_400, 1_094_400, 1_190_400],
  /** Number of CPU cores enabled by firmware (out of 4 physical cores) */
  enabledCores: 2,
  /** External temperature sensor (only reliable one) */
  reliableSensor: 'pm8916_tz',
  /**
   * ADB sysfs path for CPU frequency cap (confirmed on real hardware).
   * echo 200000 > this path to cap CPU.
   * Must be reapplied after every reboot (volatile).
   * Also kill mpdecision: `stop mpdecision` (Qualcomm CPU hotplug daemon
   * that fights frequency changes).
   */
  cpuFreqMaxPath: '/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq',
} as const
