# Huawei USB Modems

Vendor-level notes for the Huawei USB modem family. Device-specific details live
in the model subdirectories.

## Tested Models

| Model | Firmware | Mode | Notes |
|-------|----------|------|-------|
| [E8372H-153](models/e8372/README.md) | 21.328.03.00.00 | HiLink (CDC-ECM) | WiFi wingle, 9 interfaces at 0x1566 |
| [E3372 (Stick)](models/e3372/README.md) | — | Stick (serial AT) | USB storage on plug-in, SCSI CBW switch |

## USB Mode Switch

Huawei USB modems start in a storage/CD-ROM mode and need a mode-switch command
to become usable.

### Vendor control transfer (preferred for HiLink devices)

```
bmRequestType = 0x40  (vendor, host-to-device, device)
bRequest      = 0xA1
wValue = wIndex = wLength = 0
```

Returns STALL (expected — device disconnects mid-transfer). See
[switch.ts](switch.ts) for the exported constant `HUAWEI_VENDOR_SWITCH` and
its confirmed behavior notes.

### SCSI CBW command (legacy, for Stick devices)

Used by `usb_modeswitch`. Sends a proprietary command via Mass Storage bulk OUT
endpoint. See `switch.ts` for `HUAWEI_SCSI_SWITCH`.

## HiLink HTTP API

HiLink devices (E8372, E3372h) expose an XML REST API at `http://192.168.8.1/api/`.

Session management and mode-switch logic live in [protocols/hilink/](protocols/hilink/).
Full protocol documentation: [protocols/hilink/README.md](protocols/hilink/README.md).

Key points:
- Session tokens from `GET /api/webserver/SesTokInfo` rotate after each request
- CSRF token for next request is in the `__RequestVerificationToken` response header
- Password is hashed with type-4 formula before login (see `hashHiLinkPassword`)
- Some firmware versions block `/api/device/mode` (error 125002); CGI fallback available
- Account lockout (error 108006) is RAM-based; resets on USB unplug

## AT Command Compliance Issues

Huawei USB modems deviate from 3GPP standards in several ways. These are not bugs
per se — the spec often says "sent only if available" — but they create real
problems for host software that expects standard behavior.

### +CREG never includes AcT (Access Technology)

**Spec:** 3GPP TS 27.007 section 7.2 defines that with `AT+CREG=2`, both the
query response and URC include `[,<AcT>]`:

```
Response: +CREG: <n>,<stat>[,[<lac>],[<ci>],[<AcT>]]
URC:      +CREG: <stat>[,[<lac>],[<ci>],[<AcT>]]
```

The spec says: *"The parameters `<AcT>`, `<lac>` and `<ci>` are sent only if
available."* So omitting AcT is technically compliant.

**Reality:** Tested on E3372 (Stick) and E8372H-153 — neither ever includes AcT
in `+CREG?` responses or `+CREG` URCs. Even when registered on LTE with full
signal, the response is `+CREG: 2,5,"003D","00278120"` — no AcT field.

**Impact:** Host software cannot determine 2G/3G/LTE from registration commands
alone. Network technology changes (e.g. CSFB dropping from LTE to 2G for USSD)
are invisible in +CREG URCs.

**Workaround (polling):** `AT+COPS?` always includes AcT in its response:
`+COPS: 0,0,"UCOM",7` (7 = LTE). We use this as a fallback when +CREG? omits AcT.
See `protocols/at/services/network.ts` — `technologyFromCops()`.

**Workaround (real-time):** `AT^HCSQ` (see below) is the only reliable source
for real-time technology change notifications on Huawei hardware.

### ^MODE reports wrong technology on LTE

**Spec:** `^MODE` is a Huawei-proprietary URC that reports system mode changes.

**Reality:** When the modem is attached to LTE, `^MODE` still reports UMTS.
Confirmed by the [ofono E3372 LTE patch](https://ofono.ofono.narkive.com/KODljNjB/patch-0-2-huawei-e3372-add-lte-support):
*"^MODE reports UMTS attachment when modem is attached in 4G."*

**Impact:** Any code relying on `^MODE` for technology detection will show 3G
when the modem is actually on LTE.

**Workaround:** Do not use `^MODE` for technology detection. Use `^HCSQ` instead.

### ^HCSQ is the reliable technology + signal source

`AT^HCSQ` is a Huawei-proprietary command that correctly reports both the access
technology and detailed signal metrics. Available as both a query (`AT^HCSQ?`)
and URC (`^HCSQ:`).

```
^HCSQ: "LTE",<rscp>,<ecio>,<rsrp>,<rsrq>,<sinr>
^HCSQ: "WCDMA",<rscp>,<ecio>,<rsrp>
^HCSQ: "GSM",<rssi>
```

This is the **only** reliable real-time source for access technology on Huawei
modems. The ofono project uses it as the primary LTE detection mechanism.

**Status in cellary:** AT adapter uses `AT^HCSQ?` via the profile's `signal`
config to provide RSRP/RSRQ/SINR/technology. AT wins for all services;
HiLink only claims priority for traffic (session/monthly stats).

### Summary table

| Source | Technology accuracy | Signal data | Real-time (URC) | Standard |
|--------|-------------------|-------------|-----------------|----------|
| `+CREG` | Never includes AcT | No | Yes | 3GPP |
| `+COPS?` | Correct | No | No (poll only) | 3GPP |
| `+CSQ` | No | RSSI + BER only | No (poll only) | 3GPP |
| `^MODE` | Wrong on LTE | No | Yes | Huawei |
| `^HCSQ` | Correct | RSRP/RSRQ/SINR/RSCP | Yes | Huawei |
| HiLink `/api/device/signal` | Correct (mode field) | Full (RSRP/RSRQ/SINR) | No (poll only) | Huawei HTTP |

## USB Interface Mappings (from Mobile Partner.app kext)

Source: `MobileConnectDriver.pkg` inside Huawei's official **Mobile Partner.app**
(macOS, downloaded from huawei.com). Contains `HuaweiDataCardDriver_10_9.kext` with
IOKitPersonalities declaring 142 modem-mode PIDs + per-PID interface role assignments.

### Architecture

The driver stack has 6 kext plugins, each claiming specific USB interfaces by PID:

| Kext | Role | Creates |
|------|------|---------|
| `HuaweiDataCardDriver` | Device-level driver | Claims IOUSBDevice by VID:PID |
| `HuaweiDataCardACMControl` | Serial port control | `/dev/cu.HUAWEIMobile-Pcui`, `-Modem`, `-Diag` |
| `HuaweiDataCardACMData` | Serial port data | Paired with ACMControl |
| `HuaweiDataCardECMControl` | CDC-ECM network control | HiLink/NDIS network interface |
| `HuaweiDataCardECMData` | CDC-ECM network data | Paired with ECMControl |
| `MBBEthernetData` | NCM/RNDIS network | Newer Balong platform devices |
| `HuaweiDataCardDMM` | Device Mode Manager | CDMA device management |
| `MBBUSBMassStorageDeviceClass` | Storage mode | Catches VID 0x12d1 + any PID |
| `MBBActivateDriver` | Activation | CDMA/TD-SCDMA activation |

### Serial port naming convention

The macOS kext creates `/dev/cu.HUAWEIMobile-*` serial ports. The suffix maps to
the USB interface role from the kext personality name:

| Suffix | Role | AT commands? |
|--------|------|-------------|
| `-Pcui` | PC UI interface | Yes -- primary AT command port |
| `-Modem` | Modem/PPP data | Yes -- used for PPP dial, also accepts AT |
| `-Diag` | Diagnostics | No -- binary diagnostic protocol (DM/QCDM) |
| `-GPS` | NMEA GPS output | No -- NMEA sentences only |
| `-Control` | ECM/NDIS control | No -- CDC-ECM management |
| `-PCVOICE` | Voice audio | No -- audio stream |

**For cellary:** The PCUI interface is always the AT command port. The interface
number varies by PID -- see the per-PID table below.

### Interface layout patterns

Most PIDs follow one of these layouts:

**Pattern A: AT-only (no NDIS)** -- 3 serial interfaces
```
intf0: Modem    intf1: Diag    intf2: PCUI
```

**Pattern B: HiLink+AT combo** -- serial + ECM
```
intf0: PCUI     intf1: ECM-ctrl    intf2: ECM-data
```
or with more interfaces:
```
intf0: Modem    intf1: Diag    intf2: PCUI    intf3: ECM-ctrl    intf4: ECM-data
```

**Pattern C: Extended** -- serial + ECM + GPS + control
```
intf0: Modem  intf1: Diag  intf2: PCUI  intf3: GPS  intf4: Control  intf5: ECM-ctrl  intf6: ECM-data
```

### Key PIDs and their PCUI interfaces

Selected PIDs relevant to our tested/supported hardware:

| PID | PCUI intf | ECM ctrl intf | Layout | Notes |
|-----|-----------|---------------|--------|-------|
| 0x1506 | 0 | - | AT-only | E3372 stick mode (confirmed) |
| 0x1566 | 2 | - | not in kext | E8372 HiLink+AT (confirmed, 9 interfaces) |
| 0x14db | - | - | not in kext | E8372 HiLink-only |
| 0x14dc | 0 | - | not in kext | E3372 HiLink mode |
| 0x14ac | 0 | 1 | HiLink+AT | Generic HiLink reference PID |
| 0x1404 | 2 | 5 | Extended | Modem(0) Diag(1) PCUI(2) GPS(3) Control(4) ECM(5,6) |
| 0x1407 | 1 | 4 | Extended | MDM(0) PCUI(1) GPS(2) Control(3) ECM(4,5) |

**Note:** PIDs 0x1566, 0x14db, 0x14dc are NOT in the Mobile Partner kext -- they
are newer HiLink-era PIDs. Mobile Partner predates HiLink (it's the "stick mode"
management tool). These PIDs are handled by macOS built-in CDC-ECM/ACM drivers.

### PID ranges by category

| Range | Count | Category |
|-------|-------|----------|
| 0x1001-0x1425 | ~45 | Legacy AT-only modems (E220, E1550, etc.) |
| 0x142c-0x14ac | ~90 | AT + ECM combo (HiLink-compatible hardware) |
| 0x14d0-0x14d6 | ~5 | Mixed ECM/Ethernet |
| 0x1506-0x151f | ~20 | AT-only stick modes |
| 0x156d-0x15e3 | ~30 | AT-only (newer, odd PIDs only) |
| 0x1c06-0x1c22 | ~15 | NCM/MBB Ethernet (Balong 711+ platform) |
| 0x1d03-0x1d55 | ~15 | TD-SCDMA and CDMA devices |

### HWNetCfg (network manager daemon)

The `HWNetCfg` binary in `HWNetMgr.pkg` is a macOS daemon that:
- Scans IOKit for ports named `HUAWEIMobile-Modem`
- Creates a PPP network service using SystemConfiguration framework
- Sets the modem script to "HUAWEI Mobile.ccl" (standard Apple CCL format)
- Manages DNS for NDIS/ECM connections (`DeleteNdisConnect`, `ClearDnsEthernetDevice`)
- Handles fast user switch disconnect

Source paths in binary: `sdk/src/OSDialup/mac/HWNetMgr_CODE/src/Server.c`

### HWPortCfg (port detection daemon)

The `HWPortCfg` binary in `HWPortDetect.pkg` is a launchd agent that:
- Monitors IOKit for USB device insertion via `DADiskSetOptions`
- Searches for serial ports matching `HUAWEIMobile-Pcui` (IOSerialBSDClient)
- Auto-launches Mobile Partner.app when a Huawei device is plugged in
- Reads `SysConfig.dat` for app path and config
- Creates `/usr/local/DatacardService/` for runtime data
- Logs to `/usr/local/DatacardService/PortDetect.log`

Source paths in binary: `AutoRun/src/PortDetect.c`, `AutoRun/src/ActiveVolumeProgram.c`

## AT Command Profile

[profile.ts](profile.ts) — `huaweiProfile` extends the 3GPP baseline with:
- `AT^CURC=0` on init (suppresses noisy `^DSFLOWRPT` URCs)
- Huawei URC prefixes: `^RSSI`, `^HCSQ`, `^MODE`, `^BOOT`, `^SIMST`, `^SRVST`, etc.
- Vendor command overrides: `AT^ICCID?` for ICCID, `AT^DDSETEX=2` before ATD
- SIM Toolkit: `^STSF`, `^STGI`, `^STGR`

Tested on: E3372 (Stick), E3531, E8372.
