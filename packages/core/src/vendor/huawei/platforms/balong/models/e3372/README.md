# Huawei E3372

## Hardware

- **Vendor ID:** 0x12D1
- **Product IDs:**
  - Storage mode (CD-ROM): 0x14FE, 0x1F01
  - Modem mode (Stick): 0x1506
  - HiLink mode (CDC Ethernet): 0x14DC
- **Firmware variants:**
  - **E3372s (Stick)** -- presents serial ports after mode-switch, AT command access, no web UI
  - **E3372h (HiLink)** -- presents CDC Ethernet after mode-switch, web UI at 192.168.8.1, limited AT access
- **Our unit:** Stick firmware (0x14FE -> 0x1506 after mode-switch)

## USB Mode Switch

The E3372 always starts in storage mode (virtual CD-ROM with driver installer). Needs a mode-switch command to become usable.

- **Method:** Huawei proprietary SCSI-like command via USB Mass Storage Bulk OUT endpoint (CBW format)
- This is the "classic" Huawei switch used by `usb_modeswitch` -- works for Stick-firmware devices
- Does NOT work for all Huawei devices (see E8372 which requires a vendor control transfer instead)
- After switch, device re-enumerates with a new product ID
- Which product ID appears (0x1506 vs 0x14DC) depends on firmware variant, not on the command sent
- Mode-switch is needed every time the device is plugged in

### cellary integration

`prepare()` handles the full flow: scan -> open -> switch -> poll for re-enumeration.

**Known issue:** `switchDevice()` is exported as public API but takes a raw `usb.Device` object (from the `usb` npm package), not a `DiscoveredDevice` from `scan()`. Users will naturally try to pass `scan()` results and get a confusing "No mass storage interface found" error. Either don't export `switchDevice` publicly, or make it accept `DiscoveredDevice`.

### macOS notes

- Requires `sudo` for USB access (libusb permission)
- After mode-switch, serial ports appear at `/dev/tty.HUAWEIMobile*` (not confirmed on our unit -- need to verify)
- No additional drivers needed (CDC ACM is natively supported)

## AT Command Access

- **AT interface:** USB interface 1 (bInterfaceProtocol = 1)
- **Profile:** Huawei (vendor `^` prefix commands)
- **Init sequence:** ATE0, AT+CMEE=1, AT+CMGF=0, AT+CNMI=2,1,0,0,0, AT+CREG=2, AT+CGREG=1, AT+CLIP=1, AT^CURC=0, AT^USSDMODE=0

### Supported AT commands (verified on our unit)

- Standard 3GPP: AT+CMGS, AT+CMGR, AT+COPS, AT+CSQ, AT+CREG, AT+CUSD, etc.
- Huawei vendor: AT^SYSCFGEX, AT^HCSQ, AT^ICCID?, AT^CURC
- CLAC output includes: `^STSF`, `^STGI`, `^STGR` (STK commands present)

### Quirks

- **AT+CCID hangs** instead of returning ERROR. Use AT^ICCID? for ICCID retrieval (Huawei vendor command). Short timeout (1500ms) on AT+CCID ensures fast fallback.
- **AT^CURC=2 returns CME ERROR** on our unit. AT^CURC=0 works for disabling unsolicited reports.
- **+CREG never includes AcT** — even with AT+CREG=2, neither query nor URC includes access technology. See [Huawei AT Command Compliance Issues](../../README.md#at-command-compliance-issues) for details and workarounds.

## USSD

### AT^USSDMODE=0 required

Huawei modems default to PDU-encoded USSD. Without `AT^USSDMODE=0`, sending
`AT+CUSD=1,"*100#",15` returns **CME ERROR 304** ("invalid PDU mode parameter").
The modem expects hex-encoded GSM 7-bit PDU, not plain text.

`AT^USSDMODE=0` switches USSD to plain text mode. Added to init sequence.

**Discovery path:** CME 304 is Huawei vendor-specific, not in 3GPP CME table.
Forum sources (eko.one.pl, ModemManager mailing list) confirmed the PDU encoding
mismatch. Some Huawei models only accept PDU, others only accept plain text --
E3372 stick firmware needs plain text mode explicitly set.

### Roaming / operator restrictions

Even with correct encoding, some USSD codes may fail in roaming or on data-only
SIM plans. This is a network-side restriction, not a modem issue. Example: Yota
data SIM rejects `*100#` (balance check is phone-tariff only).

## SIM Toolkit (STK) -- NOT WORKING

### What we tested

1. `AT^STSF=1` -- OK, enables STK
2. `AT^STSF?` -- returns `^STSF:1,FFFFFFFF7FFF00DFDF03001FE2000000C3CB000000010000910000000008,119` (full Terminal Profile loaded)
3. `AT^STGI=37` -- CME ERROR (expected: reactive protocol, needs pending `^STIN` first)
4. Waited 8+ seconds for `^STIN` URC -- never arrived
5. Disabled and re-enabled STK -- no `^STIN` after toggle
6. `AT^CURC=2` -- CME ERROR (can't re-enable unsolicited reports this way)
7. SIM card confirmed working: shows STK menu when inserted in a phone

### Conclusion

The E3372 (Stick firmware) accepts STK enable commands and reports a full Terminal Profile, but **never delivers `^STIN` proactive command indications** to the AT port. The firmware does not forward STK events from the SIM to the host.

### Broader research (March 2026)

- **No one online has documented `^STIN` working on any Huawei USB dongle** (E153, E1550, E3372, E3531)
- XDA Forums: user with E153 reports empty STK menu in Mobile Partner, same SIM works in phone. Zero replies (2013)
- DC-unlocker forum: E1550 STK question, no confirmed working example
- **Huawei official AT specs for MU709, ME909** modules don't include STSF/STIN/STGI/STGR commands at all
- **ModemManager** (Linux modem framework) has zero STK support as of 2023
- **Sierra Wireless EM7565** also doesn't support proactive STK commands
- **STK via AT actually works on:** Multitech (MMCModem GPRS) and Telit M2M/IoT modules. These use `+STIN`/`+STGI`/`+STGR` (plus prefix, not caret). Python library ModemDriver shows working examples

### Why `^STSF` and `^STGI` appear in CLAC

The commands exist in firmware (possibly inherited from the chipset SDK) but the URC delivery mechanism (`^STIN`) is not implemented. The commands are "dead code" in the AT command table -- they parse and respond, but the proactive command pipeline is disconnected.

## Voice Calls

Voice **signaling** works after enabling NV item 8471: outgoing calls connect
(`^CONN` / `AT+CLCC` stat=0), incoming calls ring with CLIP, and the Huawei voice
URCs (`^ORIG`, `^CONF`, `^CONN`, `^CEND`, ...) auto-generate. But calls drop after
a few seconds -- the E3372 stock firmware has **no usable voice audio path**: the
USB voice endpoint is absent from the default port composition and the analog
codec may not be populated on this PCB. A working audio path would require
firmware modification, which is out of scope for cellary. Treat the E3372 as a
data-only device.

## Balong NV Access

The E3372 Stick firmware runs on a Balong SoC. NV **read** (`AT^NVRDEX`) works on
the standard PCUI port **without** an `AT^DATALOCK` unlock -- unlike the E8372,
which blocks `AT^NVRDEX` with `CME ERROR 50`. NV **write** requires a
device-specific `AT^DATALOCK` code; computing or applying it, and the related
SIM/network-unlock and firmware-downgrade procedures, are out of scope for
cellary's read/control build.

### No ADB

E3372 Stick has no CDC-ECM (no IP network to the host), so ADB over TCP is not
available -- unlike the HiLink E8372.

### Comparison with E8372

| Feature | E3372 Stick | E8372 HiLink |
|---------|-------------|--------------|
| NV read | Works without unlock | CME ERROR 50 |
| ADB | No (no CDC-ECM) | Yes (TCP 5555) |
| AT access | Direct USB PCUI | Via appvcom1 bridge |
| Temperature | AT^CHIPTEMP (direct) | AT^CHIPTEMP (via bridge) |

### Firmware version tested

```
Manufacturer: huawei
Model: E3372
Revision: 21.180.01.00.00
Hardware: CL2E3372HM Ver.A
Build: Sep 30 2014
WebUI: WEBUI_17.100.12.06.143_HILINK
```

## Testing with cellary

```typescript
import { Modem } from 'cellary'

// Auto-detect and provision (handles mode-switch)
const modem = await Modem.detect()

// Basic operations work
const signal = await modem.network.signal()
const sim = await modem.sim.info()

// STK does NOT work on this device
await modem.stk.enable()     // succeeds
console.log(modem.stk.menu)  // undefined (^STIN never arrives)
```

## Alternatives for STK testing

- **USB Smart Card Reader** ($10-20) + SIM adapter -- direct APDU communication, bypass modem firmware entirely
- **Multitech or Telit M2M module** -- confirmed STK support via `+STIN`/`+STGI`/`+STGR`
- **SIMtrace 2** (Osmocom, ~100 EUR) -- APDU sniffer/reader/emulator for advanced work
