/**
 * `cellary daemon uninstall` -- remove the system service.
 *
 * macOS: unloads the launchd plist, kills zombie agents, deletes all artifacts.
 * Linux: stops and disables the systemd unit, then deletes it.
 */

import { execSync } from 'node:child_process'
import { existsSync, rmSync, unlinkSync } from 'node:fs'

import { defineCommand } from 'citty'

const SERVICE_LABEL = 'com.cellary.daemon'
const MODESWITCH_PREFIX = 'com.cellary.modeswitch'
const PLIST_PATH = `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`
const AGENT_PLIST_PATH = `/Library/LaunchAgents/${MODESWITCH_PREFIX}.plist`
const SUDOERS_PATH = '/etc/sudoers.d/cellary'
const CELLARY_LIB_DIR = '/usr/local/lib/cellary'
const UNIT_PATH = '/etc/systemd/system/cellaryd.service'

function safeRemove(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore
  }
}

function getConsoleUid(): number | undefined {
  try {
    const output = execSync('stat -f %u /dev/console', { encoding: 'utf-8' }).trim()
    const uid = Number.parseInt(output, 10)
    return Number.isNaN(uid) ? undefined : uid
  } catch {
    return undefined
  }
}

/**
 * Kill ALL LaunchAgent instances matching `com.cellary.modeswitch*`.
 * The install command registered agents with the exact label, but launchd
 * `kickstart` created instances with unique suffixes (e.g. `-94152-1773686827117`).
 * A simple `bootout gui/UID/com.cellary.modeswitch` misses those zombies.
 */
function killZombieMacOSAgents(consoleUid: number): number {
  let killed = 0
  try {
    const output = execSync(`launchctl list`, { encoding: 'utf-8' })
    for (const line of output.split('\n')) {
      if (!line.includes(MODESWITCH_PREFIX)) continue
      const label = line.split('\t').pop()?.trim()
      if (label === undefined) continue
      try {
        execSync(`launchctl bootout gui/${consoleUid}/${label}`, { stdio: 'pipe' })
        killed++
      } catch {
        // already gone
      }
    }
  } catch {
    // launchctl list failed
  }
  return killed
}

function uninstallMacOS(): void {
  let cleaned = false

  // Stop daemon
  if (existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload -w ${PLIST_PATH}`, { stdio: 'pipe' })
    } catch {
      // May already be unloaded
    }
    unlinkSync(PLIST_PATH)
    process.stdout.write(`Removed ${PLIST_PATH}\n`)
    cleaned = true
  }

  // Kill zombie modeswitch agents
  const uid = getConsoleUid()
  if (uid !== undefined) {
    const killed = killZombieMacOSAgents(uid)
    if (killed > 0) {
      process.stdout.write(`Killed ${killed} zombie modeswitch agent(s)\n`)
      cleaned = true
    }
  }

  // Remove LaunchAgent plist
  if (existsSync(AGENT_PLIST_PATH)) {
    safeRemove(AGENT_PLIST_PATH)
    process.stdout.write(`Removed ${AGENT_PLIST_PATH}\n`)
    cleaned = true
  }

  // Remove sudoers rule
  if (existsSync(SUDOERS_PATH)) {
    safeRemove(SUDOERS_PATH)
    process.stdout.write(`Removed ${SUDOERS_PATH}\n`)
    cleaned = true
  }

  // Remove helper scripts
  if (existsSync(CELLARY_LIB_DIR)) {
    try {
      rmSync(CELLARY_LIB_DIR, { recursive: true, force: true })
      process.stdout.write(`Removed ${CELLARY_LIB_DIR}\n`)
      cleaned = true
    } catch {
      // ignore
    }
  }

  // Kill any remaining daemon process
  try {
    const output = execSync('pgrep -f "packages/daemon/dist/main.js"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    for (const line of output.split('\n')) {
      const pid = Number.parseInt(line, 10)
      if (!Number.isNaN(pid)) {
        process.kill(pid, 'SIGTERM')
        process.stdout.write(`Killed daemon process ${pid}\n`)
        cleaned = true
      }
    }
  } catch {
    // no process found
  }

  if (cleaned) {
    process.stdout.write('Daemon uninstalled.\n')
  } else {
    process.stdout.write('Daemon is not installed.\n')
  }
}

function uninstallLinux(): void {
  if (!existsSync(UNIT_PATH)) {
    process.stdout.write('Daemon is not installed.\n')
    return
  }

  try {
    execSync('systemctl stop cellaryd', { stdio: 'inherit' })
  } catch {
    // May already be stopped
  }

  try {
    execSync('systemctl disable cellaryd', { stdio: 'inherit' })
  } catch {
    // May already be disabled
  }

  unlinkSync(UNIT_PATH)
  execSync('systemctl daemon-reload', { stdio: 'inherit' })
  process.stdout.write('Daemon uninstalled.\n')
}

export default defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Uninstall cellary daemon system service',
  },
  async run() {
    if (process.getuid?.() !== 0) {
      process.stderr.write('This command requires root privileges.\n')
      process.stderr.write('  Run: sudo cellary daemon uninstall\n')
      process.exit(1)
    }

    switch (process.platform) {
      case 'darwin':
        uninstallMacOS()
        break
      case 'linux':
        uninstallLinux()
        break
      default:
        process.stderr.write(`Platform "${process.platform}" is not yet supported.\n`)
        process.exit(1)
    }
  },
})
