/**
 * Test helpers for CLI integration tests.
 *
 * These tests require a real modem connected. They are skipped automatically
 * when no operable device is found.
 */

import { type DiscoveredModem, discover } from 'cellary'

/**
 * Capture all process.stdout.write output during an async function.
 * Restores the original write method even if the function throws.
 */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)

  // Override stdout.write to capture output. The overloaded signature requires
  // a function that accepts (chunk, encoding?, callback?). We only need the chunk.
  const capture: typeof process.stdout.write = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      chunks.push(chunk)
    } else if (chunk instanceof Uint8Array) {
      chunks.push(new TextDecoder().decode(chunk))
    }
    return true
  }
  process.stdout.write = capture

  try {
    await fn()
  } finally {
    process.stdout.write = original
  }

  return chunks.join('')
}

/**
 * Probe for an operable modem.
 *
 * Returns the port/config needed for CLI commands, or undefined if no modem
 * is connected. Respects `MODEM_PORT` environment variable for explicit override.
 */
export async function probeModem(): Promise<
  { port: string | undefined; modem: DiscoveredModem } | undefined
> {
  const envPort = process.env.MODEM_PORT
  if (envPort !== undefined) {
    // Construct a minimal serial DiscoveredModem placeholder.
    // When MODEM_PORT is set, the port path is explicit -- the modem object
    // is only used for mode checks and display, not for actual discovery.
    const placeholder: DiscoveredModem = {
      mode: 'serial',
      path: envPort,
      vendorId: 0,
      productId: 0,
      name: 'MODEM_PORT override',
      deviceId: `serial:${envPort}`,
      entry: undefined,
    }
    return { port: envPort, modem: placeholder }
  }

  try {
    const modems = await discover()
    const operable = modems.filter((m) => m.mode !== 'storage')
    const first = operable[0]
    if (first === undefined) return undefined

    // Serial modems get a direct port path; others use auto-detection (port=undefined)
    const port = first.mode === 'serial' ? first.path : undefined
    return { port, modem: first }
  } catch {
    return undefined
  }
}
