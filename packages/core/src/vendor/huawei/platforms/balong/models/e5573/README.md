# Huawei E5573 (Mobile WiFi / MiFi)

LTE Cat4 pocket WiFi hotspot running HiLink firmware on Balong V7R11 (Hi6921).
Battery-powered with WiFi AP. Shares PID 0x14db with E8372 and other Balong
devices in HiLink-only mode -- identified at runtime via HiLink API.

Confirmed on: E5573Bs-320, firmware 21.333.63.00.67 (2026-03-13).

## Hardware

| Property | Value |
|----------|-------|
| Model | E5573Bs-320 |
| Firmware | 21.333.63.00.67 |
| Hardware | CL1E5573SM10 Ver.A |
| Classify | mobile-wifi |
| SoC | Hi6921 (Balong V7R11) |
| Kernel | Linux 3.4.5 |
| USB PID | 0x14db (HiLink-only, shared) |

## Radio Bands

| Technology | Bands |
|------------|-------|
| LTE | B1, B3, B5, B7, B8, B20 |
| HSPA+/UMTS | BC1, BC5, BC8 |
| GSM | 850, P900, E900, 1800, 1900 |
| WiFi | a, b, g, n |

## Differences from E8372

| Feature | E5573 | E8372 |
|---------|-------|-------|
| Form factor | Pocket WiFi (battery) | USB dongle (bus-powered) |
| AT bridge tool | `atc` binary (60KB ELF) | `atcv`/`atcv_resp` scripts |
| Battery monitoring | AT^TBATVOLT (voltage) | N/A |
| Telnet | Running by default (port 23) | Must start manually |
| FTP | Running by default (port 21) | Not present |
| WiFi | Always on (primary interface) | Optional (hotspot mode) |

## AT Bridge: `atc` Binary

E5573 firmware ships `/system/xbin/atc` -- a 60KB statically-linked ARM ELF
binary (not a shell script). Wrapper at `/sbin/atc` finds and runs it.

**Behavior** (from strings + strace):
1. Opens `/dev/appvcom1`
2. Writes `AT^CURC=0\r` (suppress URCs)
3. Writes the command argument
4. Blocking read -- waits forever for response ("Waiting for response...")
5. Writes `AT^CURC=1\r` (restore URCs)
6. Prints response to stdout

**Problem:** No timeout on the blocking read. If DSP doesn't respond, `atc`
hangs forever. This is why cellary's `BalongAtBridge` uses its own self-contained
inline script instead of calling `atc`.

**timer_start.sh** runs in a loop (10s interval), calling `atc "AT^CHIPTEMP?"`
and `atc "AT^TBATVOLT?"` to update `/data/userdata/device/dev_info.xml`.
A stuck `atc` process blocks subsequent calls and may leave appvcom1 unresponsive.

## appvcom1 Unresponsiveness

Observed on E5573Bs-320: `/dev/appvcom1` exists (`test -c` passes) but DSP
doesn't respond. Writes block forever, reads block forever. Both `atc` binary
and direct `echo`/`dd` to appvcom1 hang indefinitely.

However, `sfeature.log` shows `atc` DID get responses at boot time
(AT^SFEATURE, AT^FHVER succeeded). The `ats` daemon on `/dev/appvcom`
works fine (HiLink API returns data normally).

Possible causes:
- `atc` process from timer_start.sh got stuck, didn't release appvcom1 fd
- DSP multiplexer stopped servicing appvcom1 after some event
- Reboot expected to restore functionality

cellary handles this: `probeSerialDevice()` tests functional availability
(not just file existence) and falls through to bridge/HiLink-only mode.

## Network Services

| Port | Service | Protocol |
|------|---------|----------|
| 80 | webserver (HiLink) | HTTP |
| 5555 | adbd | ADB |
| 23 | busybox telnetd | Telnet (root shell) |
| 21 | busybox ftpd | FTP |
| 5080 | busybox httpd | HTTP (file server) |

Telnet provides an alternative root shell path without ADB.
