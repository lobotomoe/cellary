import { describe, expect, it } from 'vitest'

import { AdbShell } from '../../../src/protocols/adb/shell.js'
import type { AdbConnectionLike, AdbStream } from '../../../src/protocols/adb/wire.js'
import { Msm8916Thermal } from '../../../src/vendor/msm8916-oem/protocols/adb/thermal.js'

/**
 * Fake ADB connection driven by a command->output map.
 *
 * AdbShell.exec() calls openShell(command); execWithStatus() appends
 * "; echo ___ADB_EXIT___$?" and parses the delimiter. The map is matched by
 * substring so tests can key on the meaningful part of the command.
 */
class FakeAdbConnection implements AdbConnectionLike {
  readonly isOpen = true
  private readonly _responses: ReadonlyArray<readonly [string, string]>
  readonly commands: string[] = []

  constructor(responses: Record<string, string>) {
    this._responses = Object.entries(responses)
  }

  openShell(command: string): Promise<string> {
    this.commands.push(command)
    for (const [needle, output] of this._responses) {
      if (command.includes(needle)) return Promise.resolve(output)
    }
    return Promise.resolve('')
  }

  openStream(): Promise<AdbStream> {
    return Promise.reject(new Error('not used in thermal tests'))
  }

  onDisconnect(): void {
    // no-op
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

function makeThermal(responses: Record<string, string>): {
  thermal: Msm8916Thermal
  conn: FakeAdbConnection
} {
  const conn = new FakeAdbConnection(responses)
  const thermal = new Msm8916Thermal(new AdbShell(conn))
  return { thermal, conn }
}

describe('Msm8916Thermal.readSensors', () => {
  it('parses type:milliCelsius lines into celsius readings', async () => {
    const { thermal } = makeThermal({
      'for z in': 'pm8916_tz:55123\ntsens_tz_sensor0:69\nbms:22000\n',
    })

    const readings = await thermal.readSensors()

    expect(readings).toEqual([
      { sensor: 'pm8916_tz', celsius: 55.123 },
      { sensor: 'tsens_tz_sensor0', celsius: 0.069 },
      { sensor: 'bms', celsius: 22 },
    ])
  })

  it('surfaces a broken sensor as-is rather than hiding it', async () => {
    const { thermal } = makeThermal({ 'for z in': 'tsens_tz_sensor0:69\n' })

    const [reading] = await thermal.readSensors()

    // The broken tsens value (0.069C) is reported honestly, not masked.
    expect(reading).toEqual({ sensor: 'tsens_tz_sensor0', celsius: 0.069 })
  })

  it('returns an empty list when no thermal zones exist', async () => {
    const { thermal } = makeThermal({ 'for z in': '' })

    expect(await thermal.readSensors()).toEqual([])
  })
})

describe('Msm8916Thermal.readCpuFrequency', () => {
  it('reads max, available (sorted ascending) and current frequency', async () => {
    const { thermal } = makeThermal({
      scaling_max_freq: '800000',
      scaling_available_frequencies: '1094400 200000 800000 400000\n',
      scaling_cur_freq: '400000',
    })

    const freq = await thermal.readCpuFrequency()

    expect(freq.maxKhz).toBe(800000)
    expect(freq.currentKhz).toBe(400000)
    expect(freq.availableKhz).toEqual([200000, 400000, 800000, 1094400])
  })

  it('leaves currentKhz undefined when scaling_cur_freq is unreadable', async () => {
    const { thermal } = makeThermal({
      scaling_max_freq: '800000',
      scaling_available_frequencies: '200000 800000',
      scaling_cur_freq: 'permission denied',
    })

    const freq = await thermal.readCpuFrequency()

    expect(freq.currentKhz).toBeUndefined()
  })

  it('throws when the available-frequency list cannot be read', async () => {
    const { thermal } = makeThermal({
      scaling_max_freq: '800000',
      scaling_available_frequencies: '',
    })

    await expect(thermal.readCpuFrequency()).rejects.toThrow(/available frequencies/)
  })
})

describe('Msm8916Thermal.setMaxFrequencyKhz', () => {
  it('rejects a frequency not offered by the hardware', async () => {
    const { thermal } = makeThermal({
      scaling_available_frequencies: '200000 400000 800000',
      scaling_max_freq: '800000',
    })

    await expect(thermal.setMaxFrequencyKhz(600000)).rejects.toThrow(/not supported/)
  })

  it('stops the governor daemon before writing the cap', async () => {
    // scaling_max_freq reads 200000 after the write so the verify step passes.
    const { thermal, conn } = makeThermal({
      scaling_available_frequencies: '200000 400000 800000',
      scaling_max_freq: '200000',
    })

    await thermal.setMaxFrequencyKhz(200000)

    const stopIndex = conn.commands.findIndex((c) => c.includes('stop mpdecision'))
    const writeIndex = conn.commands.findIndex((c) => c.includes('> /sys') && c.includes('200000'))
    expect(stopIndex).toBeGreaterThanOrEqual(0)
    expect(writeIndex).toBeGreaterThan(stopIndex)
  })

  it('throws when the applied cap does not match the requested value', async () => {
    // Hardware refuses the write: scaling_max_freq still reads the stock max.
    const { thermal } = makeThermal({
      scaling_available_frequencies: '200000 400000 1190400',
      scaling_max_freq: '1190400',
    })

    await expect(thermal.setMaxFrequencyKhz(200000)).rejects.toThrow(/not applied/)
  })
})
