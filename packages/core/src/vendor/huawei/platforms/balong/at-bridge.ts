/**
 * Balong Linux AT bridge via /dev/appvcom1.
 *
 * Huawei Balong-based devices (E8372, E5573, etc.) run HiSilicon Balong Linux.
 * The modem DSP/RTOS communicates with the Linux side via virtual COM ports
 * (/dev/appvcom, /dev/appvcom1). The system AT server (ats) holds /dev/appvcom;
 * /dev/appvcom1 is the user AT port available for external commands.
 *
 * This bridge sends AT commands directly to /dev/appvcom1 without depending on
 * any firmware-specific scripts (atcv, atcv_resp, atc). Self-contained inline
 * shell scripts work on all Balong HiLink firmware variants.
 *
 * Protocol:
 *   1. Write AT^CURC=0 to suppress URCs
 *   2. Write AT+CMEE=2 for verbose errors
 *   3. Write the AT command
 *   4. Background `cat` captures modem response to a temp file
 *   5. After waitMs, kill the reader and parse captured output
 *   6. Write AT^CURC=1 to restore URC delivery
 */

import type { Logger } from '../../../../logger.js'
import { noopLogger } from '../../../../logger.js'
import type { AdbShell } from '../../../../protocols/adb/shell.js'
import type { AdbAtBridge } from '../../../../protocols/adb/types.js'

const APPVCOM_DEVICE = '/dev/appvcom1'
const TEMP_FILE = '/var/cellary_at_tmp'
const DEFAULT_WAIT_MS = 200

export class BalongAtBridge implements AdbAtBridge {
  private readonly _shell: AdbShell
  private readonly _log: Logger

  /**
   * Serialization lock. The bridge uses shared device resources
   * (temp file, /dev/appvcom1) that cannot handle concurrent access.
   * Each execute() waits for the previous one to finish before starting.
   */
  private _lock: Promise<void> = Promise.resolve()

  constructor(shell: AdbShell, logger?: Logger) {
    this._shell = shell
    this._log = logger ?? noopLogger
  }

  async execute(command: string, waitMs = DEFAULT_WAIT_MS): Promise<string> {
    // Chain onto the lock so commands run one at a time
    const prev = this._lock
    let unlock = (): void => {}
    this._lock = new Promise<void>((resolve) => {
      unlock = resolve
    })

    try {
      await prev
      return await this._exec(command, waitMs)
    } finally {
      unlock()
    }
  }

  private async _exec(command: string, waitMs: number): Promise<string> {
    this._log.debug('AT via appvcom1', { command, waitMs })
    const script = buildBridgeScript(command, waitMs)
    const result = await this._shell.exec(script, waitMs + 15_000)
    return result.stdout.replace(/\r/g, '').trim()
  }
}

/**
 * Build a self-contained shell script that sends an AT command via /dev/appvcom1.
 *
 * Does NOT depend on any firmware scripts (atcv, atcv_resp, atc). Works on all
 * Balong HiLink firmware variants (E8372, E5573, E5577, etc.).
 *
 * The script suppresses URCs, sends the command, captures the response with a
 * background `cat`, waits for the configured duration, then kills the reader
 * and parses the output.
 */
function buildBridgeScript(command: string, waitMs: number): string {
  const waitCmd = waitMs < 1000 ? `usleep ${waitMs * 1000}` : `sleep ${Math.ceil(waitMs / 1000)}`

  // Escape double quotes in the command for safe shell embedding
  const safeCommand = command.replace(/"/g, '\\"')

  return [
    'N=/dev/null',
    `P=${APPVCOM_DEVICE}`,
    `T=${TEMP_FILE}`,
    // Suppress URCs and enable verbose errors
    'echo -e "AT^CURC=0\\r" >$P 2>$N',
    'echo -e "AT+CMEE=2\\r" >$P 2>$N',
    // Send the actual command
    `echo -e "${safeCommand}\\r" >$P 2>$N`,
    // Capture response in background
    'cat $P >$T &',
    'C=$!',
    // Wait for response
    waitCmd,
    // Kill the reader
    'kill -9 $C 2>$N',
    // Restore URCs
    'echo -e "AT^CURC=1\\r" >$P 2>$N',
    // Parse: skip CURC/CMEE prefix lines, strip empty/OK/DSFL/trailing CR
    'sed "1,/CMEE/d; /^[[:space:]]*$/d; /OK/d; /DSFL/d; s/.$//" $T 2>$N',
    'rm -f $T',
  ].join('\n')
}
