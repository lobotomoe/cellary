/**
 * Thermal and CPU-frequency management.
 *
 * Present on devices that expose readable temperature sensors and a
 * software-controllable CPU frequency cap (e.g. Android-based dongles via
 * their sysfs thermal/cpufreq interfaces). Generic by design -- the transport
 * (ADB shell, vendor HTTP, etc.) and the concrete sysfs paths live in the
 * adapter implementation, not here.
 *
 * All operations are software-only. Frequency capping is reversible and, on
 * most devices, volatile (lost on reboot).
 */

/** A single temperature sensor reading. */
export interface ThermalReading {
  /** Sensor identifier as reported by the device, e.g. 'pm8916_tz', 'tsens_tz_sensor0'. */
  readonly sensor: string
  /** Temperature in degrees Celsius. */
  readonly celsius: number
}

/** CPU frequency scaling state. */
export interface CpuFrequency {
  /** Current maximum-frequency cap in kHz (scaling_max_freq). */
  readonly maxKhz: number
  /** Frequencies the hardware supports, ascending, in kHz. */
  readonly availableKhz: readonly number[]
  /** Current operating frequency in kHz, when the device exposes it. */
  readonly currentKhz?: number | undefined
}

export interface Thermal {
  /** Read every available temperature sensor. */
  readSensors(): Promise<readonly ThermalReading[]>
  /** Read the current CPU frequency scaling state. */
  readCpuFrequency(): Promise<CpuFrequency>
  /**
   * Cap the maximum CPU frequency to `khz` and ensure the cap holds.
   *
   * "Ensure it holds" is part of the contract: if a background governor or
   * hotplug daemon would otherwise override the cap, the implementation stops
   * it first. On most devices the cap is volatile -- lost on reboot.
   *
   * @throws if `khz` is not one of the device's available frequencies
   */
  setMaxFrequencyKhz(khz: number): Promise<void>
}
