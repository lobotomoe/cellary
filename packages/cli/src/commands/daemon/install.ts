/**
 * `cellary daemon install` -- install as a system service.
 *
 * macOS: writes a launchd plist to /Library/LaunchDaemons/ and loads it.
 * Linux: writes a systemd unit to /etc/systemd/system/ and enables it.
 */

import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineCommand } from 'citty'

const SERVICE_LABEL = 'com.cellary.daemon'

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * The node binary to run the daemon with: the one running this installer.
 * Resolving via `which node` depends on the caller's PATH (which sudo resets)
 * and guessing a path when that fails would write a service unit that can
 * never start.
 */
function nodePath(): string {
  return process.execPath
}

function daemonEntryPath(): string {
  const resolved = import.meta.resolve('@cellary/daemon')
  return fileURLToPath(resolved)
}

// ── macOS (launchd) ─────────────────────────────────────────────────────────

const PLIST_PATH = `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`

function generatePlist(node: string, entry: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${node}</string>`,
    `    <string>${entry}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>StandardOutPath</key><string>/var/log/cellaryd.log</string>',
    '  <key>StandardErrorPath</key><string>/var/log/cellaryd.log</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function unloadExistingMacOS(): void {
  try {
    execSync(`launchctl unload -w ${PLIST_PATH}`, { stdio: 'pipe' })
  } catch {
    // May not be loaded
  }
}

function installMacOS(): void {
  if (existsSync(PLIST_PATH)) {
    process.stdout.write('Replacing existing installation...\n')
    unloadExistingMacOS()
  }

  const node = nodePath()
  const entry = daemonEntryPath()

  if (!existsSync(entry)) {
    process.stderr.write(`Daemon entry not found at ${entry}\n`)
    process.stderr.write('Run `pnpm build` in the daemon package first.\n')
    process.exit(1)
  }

  process.stdout.write(`Node:   ${node}\n`)
  process.stdout.write(`Daemon: ${entry}\n`)

  const plist = generatePlist(node, entry)
  writeFileSync(PLIST_PATH, plist, 'utf-8')
  process.stdout.write(`Wrote ${PLIST_PATH}\n`)

  execSync(`launchctl load -w ${PLIST_PATH}`, { stdio: 'inherit' })
  process.stdout.write('Daemon installed and started.\n')
  process.stdout.write('  Logs: /var/log/cellaryd.log\n')
}

// ── Linux (systemd) ─────────────────────────────────────────────────────────

const UNIT_PATH = '/etc/systemd/system/cellaryd.service'

function generateSystemdUnit(node: string, entry: string): string {
  return [
    '[Unit]',
    'Description=cellary USB modem daemon',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${node} ${entry}`,
    'Restart=on-failure',
    'RestartSec=5',
    'StandardOutput=journal',
    'StandardError=journal',
    'SyslogIdentifier=cellaryd',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

function stopExistingLinux(): void {
  try {
    execSync('systemctl stop cellaryd', { stdio: 'pipe' })
  } catch {
    // May not be running
  }
  try {
    execSync('systemctl disable cellaryd', { stdio: 'pipe' })
  } catch {
    // May not be enabled
  }
}

function installLinux(): void {
  if (existsSync(UNIT_PATH)) {
    process.stdout.write('Replacing existing installation...\n')
    stopExistingLinux()
  }

  const node = nodePath()
  const entry = daemonEntryPath()

  if (!existsSync(entry)) {
    process.stderr.write(`Daemon entry not found at ${entry}\n`)
    process.stderr.write('Run `pnpm build` in the daemon package first.\n')
    process.exit(1)
  }

  process.stdout.write(`Node:   ${node}\n`)
  process.stdout.write(`Daemon: ${entry}\n`)

  const unit = generateSystemdUnit(node, entry)
  writeFileSync(UNIT_PATH, unit, 'utf-8')
  process.stdout.write(`Wrote ${UNIT_PATH}\n`)

  execSync('systemctl daemon-reload', { stdio: 'inherit' })
  execSync('systemctl enable --now cellaryd', { stdio: 'inherit' })
  process.stdout.write('Daemon installed and started.\n')
  process.stdout.write('  Logs: journalctl -u cellaryd -f\n')
}

// ── Command ─────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: 'install',
    description: 'Install cellary daemon as a system service',
  },
  async run() {
    if (process.getuid?.() !== 0) {
      process.stderr.write('This command requires root privileges.\n')
      process.stderr.write('  Run: sudo cellary daemon install\n')
      process.exit(1)
    }

    switch (process.platform) {
      case 'darwin':
        installMacOS()
        break
      case 'linux':
        installLinux()
        break
      default:
        process.stderr.write(`Platform "${process.platform}" is not yet supported.\n`)
        process.exit(1)
    }
  },
})
