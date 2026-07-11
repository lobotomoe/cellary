# Balong Linux Platform

Huawei's HiSilicon Balong is the SoC + Linux platform running on devices like
E8372, E5573, E5577. It is NOT a protocol -- it's the OS environment that hosts
HiLink, adbd, iptables, and the AT bridge. cellary accesses it via ADB over TCP.

Confirmed on: E8372H-153 (2026-03-08), E5573Bs-320 (2026-03-13).

## Balong Generations

| Generation | SoC | Devices | Notes |
|---|---|---|---|
| V7R1 | Hi6920 | E5372, E5377 (OLED) | Legacy, unsupported |
| V7R2 | Hi6930 | E3372s, E5373, E5786 | No longer updated |
| **V7R11** | **Hi6921** | **E8372**, **E5573**, E5577, E3372h | 128MB RAM/NAND |
| V7R22 | Hi6932 | E5785, E5885 | 256MB, vfpv4+NEON, 802.11ac |

All generations: 2 ARMv7 cores (Linux + VxWorks), 1 Cortex-M3 for boot/monitor,
ConnX BBE16 DSP for baseband.

Source: [Huawei-LTE-routers-mods](https://github.com/Huawei-LTE-routers-mods/README/blob/master/balong_series.md)

## OS Details

| Property | Value |
|----------|-------|
| SoC | Hi6921 (V7R11 generation) |
| Kernel | Linux 3.4.5, ARMv7 (Cortex-A9) |
| RAM | 41 MB total (~4 MB free) |
| Storage | NAND flash, 32 MTD partitions (yaffs2 + jffs2) |
| Root | uid=0 immediately, no sudo/auth |
| adbd | insecure, no auth handshake required |
| Shell | `/system/bin/sh` -- minimal, many commands missing |
| Busybox | 352 applets via `busybox <cmd>` (head, uname, etc. not in PATH) |

Note: `uname` reports "Hi6930" but the actual SoC is Hi6921 (V7R11).

## Two Worlds: Linux + Modem DSP

Balong has two "worlds": **Balong Linux** (ARM, runs adbd/HiLink/iptables) and
**Balong Modem** (DSP/RTOS, runs AT engine/radio/SIM). They communicate via
virtual COM ports (`/dev/appvcom*`).

## Internal Service Architecture

HiLink firmware runs a supervisor process tree under `syswatch`:

```
syswatch             -- supervisor, spawns and monitors all services
  notify_server      -- event bus (Unix stream sockets /var/run/notify/)
  ats                -- AT server, holds /dev/appvcom (fd 5), 9 threads
  webserver          -- HiLink HTTP API (port 80)
  router             -- network manager (routing, NAT)
  device             -- device state manager
  sms                -- SMS handler
  led                -- LED control
  bip                -- BIP (SIM toolkit bearer)
  sysguard           -- watchdog
  npdaemon           -- NAS proxy (/var/np_ipc/np_daemon, DGRAM)
  stacall            -- STA call (/var/np_ipc/stacall_daemon, DGRAM)
  call               -- voice call (/var/np_ipc/call_daemon, DGRAM)
  timer_start.sh     -- periodic AT polling (chiptemp, battery, timer on/off)
```

Confirmed on E5573Bs-320, expected same on E8372 and other Balong HiLink devices.

### Service Communication

- **Event bus:** `notify_server` with Unix stream sockets. Each service connects
  as `/var/run/notify/notifyclient00<PID>`.
- **NAS/call IPC:** Unix datagram sockets under `/var/np_ipc/`.
- **AT access:** `libatproxy.so` (5 KB shared library) opens `/dev/appvcom`,
  provides `write_to_usb`/`read_from_usb_thread`/`E5_APP_RegCallBack`.
  The `ats` daemon loads this library; other services (`webserver`, `device`,
  `sms`) link `libwebsdk.so` which wraps AT operations through `ats`.

### Network Services

| Port | Service | Notes |
|------|---------|-------|
| 80 | webserver | HiLink HTTP API |
| 5555 | adbd | ADB over TCP |
| 23 | busybox telnetd | Root shell (E5573; may vary by firmware) |
| 21 | busybox ftpd | FTP server (E5573) |
| 5080 | busybox httpd | File server (E5573) |

## AT Channel Architecture

```
                    Balong DSP (modem RTOS)
                           |
            +--------------+--------------+
            |              |              |
      /dev/appvcom   /dev/appvcom1    USB gadget
       (major 247)    (major 248)     ACM devices
            |              |              |
         [ats]        [user AT]     [host-facing]
```

### appvcom Virtual COM Ports (DSP-facing)

| Port | Major | Purpose |
|---|---|---|
| `/dev/appvcom` (0) | 247 | System AT -- held by `ats` daemon |
| `/dev/appvcom1` | 248 | User AT -- for external AT commands |
| 2-52 | 249-310 | Extended (available with `FEATURE_VCOM_EXT`) |
| 53-57 | - | Logging: ERRLOG, TLLOG, CBT, LOG, LOG1 |

The driver exposes `SEND_UL_AT_FUNC` callback -- bidirectional AT channels to
the modem DSP. Each port has a 64KB buffer.

Source: [AppVcomDev.h](https://github.com/rcstar6696/android_kernel_huawei_hi3660/blob/master/drivers/hisi/modem/taf/comm/src/acore/APPVCOM/Inc/AppVcomDev.h)

### ACM Devices (USB gadget, host-facing)

| Device | Major:Minor | Purpose |
|--------|-------------|---------|
| `/dev/acm_modem` | 245:0 | USB PCUI AT port |
| `/dev/ttyGS0` | 246:0 | USB gadget serial |
| `/dev/acm_gps` | 246:1 | GPS NMEA |
| `/dev/acm_4g_diag` | 246:2 | 4G diagnostics |
| `/dev/acm_3g_diag` | 246:3 | 3G diagnostics |
| `/dev/acm_c_shell` | 246:4 | Console shell |
| `/dev/acm_voice` | 246:5 | Voice data |
| `/dev/acm_ctrl` | 246:6 | Control channel |

These are USB gadget endpoints exposed to the host. Which ones are active depends
on the USB composition (controlled by `AT^U2DIAG` / PID).

## AT Bridge via `/dev/appvcom1`

The user AT port (`/dev/appvcom1`) allows sending AT commands from Linux userspace
to the modem DSP. Different firmware versions ship different bridge tools:

| Firmware | Tool | Type | Found on |
|----------|------|------|----------|
| E8372 HiLink | `atcv` + `atcv_resp` | Shell scripts (623B + 176B) | `/app/webroot/mbin/` |
| E5573 HiLink | `atc` | Statically-linked ARM ELF (60KB) | `/system/xbin/atc` |

Both tools follow the same protocol:
1. Send `AT^CURC=0` to suppress URCs
2. Send the AT command
3. Read the response from appvcom1
4. Send `AT^CURC=1` to restore URCs

**cellary's bridge** (`BalongAtBridge`) does NOT depend on either tool. It generates
a self-contained inline shell script that writes directly to `/dev/appvcom1`.
Works on all Balong HiLink firmware. See [at-bridge.ts](at-bridge.ts).

**Serialization:** Only one process can use `/dev/appvcom1` at a time.
`BalongAtBridge` enforces this with a promise-chain mutex.

**Known issue:** appvcom1 may become unresponsive (DSP stops servicing the port).
Confirmed on E5573Bs-320 -- writes block forever. A reboot restores functionality.
The plugin's serial probe detects this condition and falls through to bridge mode.

### AT Commands via appvcom1

**Working** (confirmed on E8372H-153 HiLink-only 0x14db):

| Command | Notes |
|---------|-------|
| ATI | Manufacturer, Model, Revision, IMEI |
| AT+CGSN | IMEI |
| AT^HCSQ? | LTE RSSI, RSRP, SINR, RSRQ |
| AT^CHIPTEMP? | Chip temperature (tenths of C) |
| AT^VERSION? | All firmware/hardware versions |
| AT^SYSINFOEX | LTE registration status |
| AT^CARDLOCK? | SIM lock status |

**Blocked** (CME ERROR):

| Command | Error | Reason |
|---------|-------|--------|
| AT+CIMI, AT+CSQ, AT+COPS? | CME ERROR: 10 | SIM locked by HiLink daemon |
| AT^NVRDEX | CME ERROR: 50 | NV access blocked in firmware |

## NV Storage

- **Path:** `/mnvm2:0/nv.bin` (987 KB, mtdblock4 yaffs2)
- **Format:** Magic `DIN"` (0x44494e22), header + sub-table + item table + data
- **AT read:** `AT^NVRDEX` -- blocked with `CME ERROR 50` on HiLink firmware such
  as the E8372; available on the E3372 Stick

NV write and the `AT^DATALOCK` unlock it requires are out of scope for cellary's
read/control build.

## Shell Access Methods

**1. ADB over TCP (our method, no unlock needed):**
ADB at 192.168.8.1:5555. No RSA auth. Works on PID 0x14db and 0x1566.

**2. AT serial shell:** a "FC ShallB" root serial port can be exposed via
`AT^SHELL=2` after an `AT^DATALOCK` unlock -- out of scope for cellary's
read/control build.

**3. Telnet (from shell):** `busybox telnetd -l /bin/sh`
On E5573, telnetd is already running (port 23).

## iptables (TTL manipulation)

```sh
iptables -t mangle -A POSTROUTING -o wan0 -j TTL --ttl-set 64
```

Interface is `wan0` (LTE uplink). Rules lost on reboot; persist via
`/system/etc/autorun.sh` (requires `mount -o remount,rw /system`).

## Filesystem Layout

```
/system/bin/    -- busybox, iptables, switch_modem
/sbin/          -- atcv or atc wrapper, ueventd, watchdogd
/app/           -- HiLink web UI, CGI scripts, mbin/
/data/          -- runtime data, XML configs
/mnvm2:0/       -- NV storage (nv.bin)
/dev/appvcom*   -- AT virtual COM ports (DSP-facing)
/dev/acm_*      -- USB gadget ACM devices (host-facing)
```

## Community Resources

- [Huawei-LTE-routers-mods](https://github.com/Huawei-LTE-routers-mods/README) -- firmware, tools, device database
- [modfw_kitchen](https://github.com/Huawei-LTE-routers-mods/huawei_balong_modfw_kitchen) -- firmware builder
- [decker.su](http://www.decker.su/2015/08/huawei-e8372-8211f-ttl64.html) -- E8372 console + TTL guide
- [AppVcomDev.h](https://github.com/rcstar6696/android_kernel_huawei_hi3660/blob/master/drivers/hisi/modem/taf/comm/src/acore/APPVCOM/Inc/AppVcomDev.h) -- appvcom kernel source

## Code Structure

```
balong/
  README.md       -- this file (platform-level docs)
  at-bridge.ts    -- BalongAtBridge: self-contained AT via /dev/appvcom1
  device.ts       -- BalongDevice: device info + temperature via bridge
  models/
    e3372/        -- E3372 Stick model (see README.md)
    e5573/        -- E5573 MiFi model (see README.md)
    e8372/        -- E8372 Wingle model (see README.md)
```

Injected into `AdbAdapter` by the Huawei plugin (`../plugin.ts`).
