/**
 * MSM8916 sysfs paths and shell primitives for thermal / CPU-frequency control.
 *
 * These are Qualcomm/Android specifics -- they live in the vendor layer, not in
 * the generic Thermal service interface. Confirmed on a UZ801 v3.0 board
 * (Android 4.4.4, kernel 3.10.28).
 */

/** cpufreq policy directory. On MSM8916 all cores share cpu0's policy. */
export const CPUFREQ_DIR = '/sys/devices/system/cpu/cpu0/cpufreq'

export const SCALING_MAX_FREQ_PATH = `${CPUFREQ_DIR}/scaling_max_freq`
export const SCALING_CUR_FREQ_PATH = `${CPUFREQ_DIR}/scaling_cur_freq`
export const SCALING_AVAILABLE_FREQ_PATH = `${CPUFREQ_DIR}/scaling_available_frequencies`

/** Glob for kernel thermal zones. */
export const THERMAL_ZONE_GLOB = '/sys/class/thermal/thermal_zone*'

/**
 * Android init service that dynamically scales CPU frequency and hot-plugs
 * cores. It overrides manual scaling_max_freq writes within ~1s, so it MUST be
 * stopped before a frequency cap will hold.
 */
export const CPU_GOVERNOR_DAEMON = 'mpdecision'

/**
 * Kernel thermal ABI: each zone's temp node is reported in millidegrees Celsius
 * (ref: Documentation/thermal/sysfs-api.txt). A broken sensor (e.g. tsens on
 * this firmware) simply reports a wrong millidegree value; it is surfaced as-is
 * rather than hidden -- the consumer decides which sensor to trust.
 */
export const MILLI_CELSIUS_PER_CELSIUS = 1000

/**
 * Lists every thermal zone as "type:milliCelsius", one per line. The file-exists
 * guard emits nothing (not an error line) when no zones exist, so a device with
 * no thermal subsystem parses cleanly to an empty list.
 */
export const READ_SENSORS_COMMAND = `for z in ${THERMAL_ZONE_GLOB}; do [ -f "$z/type" ] && echo "$(cat "$z/type"):$(cat "$z/temp")"; done`
