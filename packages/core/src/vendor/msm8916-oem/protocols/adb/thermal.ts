/**
 * MSM8916 Thermal service implementation over ADB shell.
 *
 * Reads kernel thermal zones and cpufreq sysfs, and caps the maximum CPU
 * frequency. Capping stops the mpdecision daemon first (otherwise it restores
 * the stock maximum within ~1s) and then verifies the write took effect.
 *
 * The cap is volatile -- lost on reboot. Re-applying it is the job of the
 * thermal remediation, not this service.
 */

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { AdbShell } from '../../../../protocols/adb/shell.js'
import type {
  CpuFrequency,
  Thermal,
  ThermalReading,
} from '../../../../protocols/services/thermal.js'
import {
  CPU_GOVERNOR_DAEMON,
  MILLI_CELSIUS_PER_CELSIUS,
  READ_SENSORS_COMMAND,
  SCALING_AVAILABLE_FREQ_PATH,
  SCALING_CUR_FREQ_PATH,
  SCALING_MAX_FREQ_PATH,
} from './constants.js'

const SENSOR_LINE_REGEX = /^(.+):(-?\d+)$/
const INTEGER_REGEX = /^\d+$/

export class Msm8916Thermal implements Thermal {
  private readonly _shell: AdbShell
  private readonly _log: Logger

  constructor(shell: AdbShell, logger?: Logger) {
    this._shell = shell
    this._log = logger ?? noopLogger
  }

  async readSensors(): Promise<readonly ThermalReading[]> {
    const result = await this._shell.exec(READ_SENSORS_COMMAND)
    const readings: ThermalReading[] = []

    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue

      const [, sensor, milli] = SENSOR_LINE_REGEX.exec(trimmed) ?? []
      if (sensor === undefined || milli === undefined) continue

      readings.push({ sensor, celsius: Number(milli) / MILLI_CELSIUS_PER_CELSIUS })
    }

    return readings
  }

  async readCpuFrequency(): Promise<CpuFrequency> {
    const maxKhz = await this._readFreqFile(SCALING_MAX_FREQ_PATH)
    const availableKhz = await this._readFreqList(SCALING_AVAILABLE_FREQ_PATH)
    const currentKhz = await this._tryReadFreqFile(SCALING_CUR_FREQ_PATH)
    return { maxKhz, availableKhz, currentKhz }
  }

  async setMaxFrequencyKhz(khz: number): Promise<void> {
    const { availableKhz } = await this.readCpuFrequency()
    if (!availableKhz.includes(khz)) {
      throw new Error(
        `Frequency ${khz} kHz is not supported. Available: ${availableKhz.join(', ')} kHz`,
      )
    }

    // The cap only holds if the dynamic governor daemon is stopped first --
    // otherwise it restores the stock maximum within ~1s.
    this._log.info('Stopping CPU governor daemon', { daemon: CPU_GOVERNOR_DAEMON })
    await this._shell.exec(`stop ${CPU_GOVERNOR_DAEMON}`)

    this._log.info('Capping max CPU frequency', { khz })
    const write = await this._shell.execWithStatus(`echo ${khz} > ${SCALING_MAX_FREQ_PATH}`)
    if (write.exitCode !== undefined && write.exitCode !== 0) {
      throw new Error(`Failed to write scaling_max_freq: ${write.stdout}`)
    }

    const applied = await this._readFreqFile(SCALING_MAX_FREQ_PATH)
    if (applied !== khz) {
      throw new Error(`CPU frequency cap not applied: wanted ${khz} kHz, got ${applied} kHz`)
    }
    this._log.info('Max CPU frequency capped', { khz })
  }

  private async _readFreqFile(path: string): Promise<number> {
    const value = await this._tryReadFreqFile(path)
    if (value === undefined) {
      throw new Error(`Could not read a CPU frequency value from ${path}`)
    }
    return value
  }

  private async _tryReadFreqFile(path: string): Promise<number | undefined> {
    const result = await this._shell.exec(`cat ${path}`)
    const text = result.stdout.trim()
    if (!INTEGER_REGEX.test(text)) return undefined
    return Number(text)
  }

  private async _readFreqList(path: string): Promise<number[]> {
    const result = await this._shell.exec(`cat ${path}`)
    const freqs: number[] = []

    for (const part of result.stdout.trim().split(/\s+/)) {
      if (INTEGER_REGEX.test(part)) freqs.push(Number(part))
    }

    if (freqs.length === 0) {
      throw new Error(`Could not read available frequencies from ${path}`)
    }
    return freqs.sort((a, b) => a - b)
  }
}
