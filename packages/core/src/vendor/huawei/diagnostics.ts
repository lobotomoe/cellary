/**
 * Huawei diagnostic AT command tables and the diagnose() implementation.
 *
 * All lookup tables and regex patterns are module-private — callers use
 * diagnoseHuawei() rather than accessing the raw tables directly.
 */

import type { VendorProbe } from '../../protocols/adapter.js'

// AT^SYSINFOEX / AT^SYSINFO srv_status field -- Huawei AT command spec
const SRV_STATUS: Record<number, string> = {
  0: 'no service',
  2: 'limited service',
  3: 'service available',
  4: 'limited regional service',
  255: 'unknown',
}

// AT^SDOMAIN -- Huawei proprietary (0=CS only, 1=PS only, 2=CS+PS)
const SDOMAIN_LABEL: Record<number, string> = {
  0: 'CS only',
  1: 'PS only',
  2: 'CS+PS',
}

// AT^SYSINFOEX / AT^SYSINFO srv_domain field -- Huawei AT command spec
const SRV_DOMAIN: Record<number, string> = {
  0: 'no service',
  1: 'CS only',
  2: 'PS only',
  3: 'CS+PS',
  255: 'unknown',
}

// AT^SYSINFO sys_mode field -- Huawei AT command spec
const SYS_MODE: Record<number, string> = {
  0: 'no service',
  1: 'AMPS',
  2: 'CDMA',
  3: 'GSM/GPRS',
  4: 'HDR',
  5: 'WCDMA',
  6: 'GPS',
  7: 'GSM/WCDMA',
  8: 'CDMA/HDR hybrid',
  15: 'TD-SCDMA',
  17: 'HSPA+',
}

// ^SYSINFOEX: <srv_status>,<srv_domain>,<roam>,<sim_state>,<lock_state>,<sysmode>,"<sysmode_name>",<submode>,"<submode_name>"
const SYSINFOEX_REGEX = /\^SYSINFOEX:\s*(\d+),(\d+),(\d+),\d+,\d+,\d+,"([^"]*)",\d+,"([^"]*)"/

// ^SYSINFO: <srv_status>,<srv_domain>,<roam>,<sys_mode>,<sim_state>[,<lock_state>,<sys_submode>]
const SYSINFO_REGEX = /\^SYSINFO:\s*(\d+),(\d+),(\d+),(\d+),/

// ^SDOMAIN: <domain>
const SDOMAIN_REGEX = /\^SDOMAIN:\s*(\d+)/

// ^USERSRVSTATE: <cs>,<ps>
const USERSRVSTATE_REGEX = /\^USERSRVSTATE:\s*(\d+),(\d+)/

function joinRaw(lines: readonly string[]): string {
  if (lines.length === 0) return 'no response'
  return lines.join(' | ')
}

/**
 * Run Huawei-specific diagnostic AT commands and return label-value pairs.
 * Covers: service domain (^SDOMAIN), system info (^SYSINFOEX / ^SYSINFO),
 * and user service state (^USERSRVSTATE).
 */
export async function diagnoseHuawei(probe: VendorProbe): Promise<readonly [string, string][]> {
  const pairs: [string, string][] = []

  // ── Service domain setting (^SDOMAIN) ────────────────────────────────────
  const sdomainLines = await probe('AT^SDOMAIN?')
  const sdomainMatch = SDOMAIN_REGEX.exec(sdomainLines[0] ?? '')
  if (sdomainMatch) {
    const [, code] = sdomainMatch
    pairs.push([
      'Service domain setting',
      code !== undefined ? (SDOMAIN_LABEL[Number(code)] ?? `code ${code}`) : 'unknown',
    ])
  } else {
    pairs.push(['Service domain setting', joinRaw(sdomainLines)])
  }

  // ── Extended system info (^SYSINFOEX, fallback ^SYSINFO) ─────────────────
  const sysinfoexLines = await probe('AT^SYSINFOEX')
  const sysinfoexMatch = SYSINFOEX_REGEX.exec(sysinfoexLines[0] ?? '')

  if (sysinfoexMatch) {
    const [, srvStatus, srvDomain, roam, sysmode, submode] = sysinfoexMatch
    if (srvStatus !== undefined) {
      pairs.push(['Service status', SRV_STATUS[Number(srvStatus)] ?? srvStatus])
    }
    if (srvDomain !== undefined) {
      pairs.push(['Active domain', SRV_DOMAIN[Number(srvDomain)] ?? srvDomain])
    }
    if (roam !== undefined) {
      pairs.push(['Roaming', roam === '1' ? 'yes' : 'no'])
    }
    if (sysmode !== undefined) {
      const modeStr = submode !== undefined && submode !== '' ? `${sysmode} / ${submode}` : sysmode
      pairs.push(['Radio mode', modeStr])
    }
  } else {
    const sysinfoLines = await probe('AT^SYSINFO')
    const sysinfoMatch = SYSINFO_REGEX.exec(sysinfoLines[0] ?? '')

    if (sysinfoMatch) {
      const [, srvStatus, srvDomain, roam, sysMode] = sysinfoMatch
      if (srvStatus !== undefined) {
        pairs.push(['Service status', SRV_STATUS[Number(srvStatus)] ?? srvStatus])
      }
      if (srvDomain !== undefined) {
        pairs.push(['Active domain', SRV_DOMAIN[Number(srvDomain)] ?? srvDomain])
      }
      if (roam !== undefined) {
        pairs.push(['Roaming', roam === '1' ? 'yes' : 'no'])
      }
      if (sysMode !== undefined) {
        pairs.push(['Radio mode', SYS_MODE[Number(sysMode)] ?? `code ${sysMode}`])
      }
    } else {
      pairs.push([
        'System info (raw)',
        `^SYSINFOEX: ${joinRaw(sysinfoexLines)} | ^SYSINFO: ${joinRaw(sysinfoLines)}`,
      ])
    }
  }

  // ── User service state (^USERSRVSTATE) ───────────────────────────────────
  const usersrvLines = await probe('AT^USERSRVSTATE')
  const usersrvMatch = USERSRVSTATE_REGEX.exec(usersrvLines[0] ?? '')
  if (usersrvMatch) {
    const [, cs, ps] = usersrvMatch
    const csLabel = cs === '1' ? 'CS available' : 'CS unavailable'
    const psLabel = ps === '1' ? 'PS available' : 'PS unavailable'
    pairs.push(['User service state', `${csLabel}, ${psLabel}`])
  } else {
    pairs.push(['User service state', joinRaw(usersrvLines)])
  }

  // ── Voice capability (^CVOICE?) ─────────────────────────────────────────
  const cvoiceLines = await probe('AT^CVOICE?')
  const cvoiceRaw = cvoiceLines[0] ?? ''
  if (cvoiceRaw.startsWith('^CVOICE:')) {
    // ^CVOICE: 0,8000,16,20 — voice supported (mode, sample rate, bits, frame)
    pairs.push(['Voice', `supported (${cvoiceRaw.slice('^CVOICE:'.length).trim()})`])
  } else if (cvoiceLines.length === 0) {
    pairs.push(['Voice', 'not supported (no response)'])
  } else {
    pairs.push(['Voice', `not supported (${joinRaw(cvoiceLines)})`])
  }

  return pairs
}
