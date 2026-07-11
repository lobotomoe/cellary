# Huawei E8372

## Hardware

- **Type:** USB LTE WiFi hotspot (Wingle)
- **Our unit:** E8372H-153, firmware 21.328.03.00.00
- **Vendor ID:** 0x12D1
- **Product IDs:**
  - Storage mode (CD-ROM): 0x1F01
  - HiLink mode: 0x1566
- **SIM:** YOTA (MTS MVNO), UICC/USIM

## USB Mode Switch

### What does NOT work

| Method | Result |
|--------|--------|
| Huawei SCSI bulk command (CBW) | Device stays at 0x1F01 |
| Standard SCSI eject (START STOP UNIT) | Device stays at 0x1F01 |
| USB SET_CONFIGURATION(0) | Device stays at 0x1F01 |
| Vendor control 0x40/0x02 (various wValue) | LIBUSB_TRANSFER_STALL |
| Standard SET_FEATURE 0x00/0x03 | LIBUSB_TRANSFER_STALL |

### What WORKS

**USB vendor control transfer:**

```
bmRequestType = 0x40  (vendor, host-to-device, device)
bRequest      = 0xA1  (Huawei HiLink switch command)
wValue        = 0x0000
wIndex        = 0x0000
wLength       = 0x0000
data          = none
```

Returns `LIBUSB_TRANSFER_STALL` (device disconnects mid-transfer), but the switch
succeeds. Device re-enumerates as 0x1566 within ~2 seconds.

### How we found this

Reverse-engineered from `mbbservice` binary on the virtual CD-ROM:

1. Extracted from `HiLink 2.app/Contents/Resources/mbbserviceSetup.pkg/Contents/Archive.pax.gz`
2. Binary is Mach-O i386, pure C (Carbon + IOKit + CoreFoundation)
3. Disassembled `_activateDevice` function with `otool -tV`
4. Found IOUSBDevRequest struct at offsets 0x692e-0x6948:
   - `movb $0x40, -0x44(%ebp)` -- bmRequestType
   - `movb $-0x5f, -0x43(%ebp)` -- bRequest (0xA1 = 256 - 0x5F)
   - Remaining fields zeroed
5. Called via `IOUSBDeviceInterface::DeviceRequest`

### ArConfig.dat product ID pairs

Found in `mbbservice` strings (hilink_pid,storage_pid):

```
14db,1f01  -- E8372 variant (pure HiLink, no AT)
14dc,1f01  -- E3372h
14bb,1f10
14bc,1f11
14be,1f13
14f6,1f13
14db,1f12
```

Note: 0x14db appears twice (two different E8372 firmware variants both use it).

## USB Port Mode (AT^U2DIAG)

The E8372 firmware has two USB interface configurations controlled by the
`AT^U2DIAG` vendor command. The command takes effect after USB reconnect.

| AT^U2DIAG value | Product ID | Interfaces | Use case |
|----------------|------------|------------|----------|
| 256 (0x100) | **0x1566** | CDC-ECM + AT PCUI + diag + GPS + mass storage | Normal mode (AT access available) |
| 0 | **0x14db** | CDC-ECM + mass storage only | Pure HiLink, no AT interface |

**Our unit defaults to 0x1566 after storage→modem mode switch (0x1F01 → 0x1566).**

The 0x14db mode is reached by sending `AT^U2DIAG=0` from the AT port while in
0x1566 mode. To recover from 0x14db back to 0x1566:

### Recovery from 0x14db (confirmed 2026-03-03, E8372H-153 fw 21.328.03.00.00)

**Root cause:** `AT^U2DIAG=0` was stored in NVM. The device boots to whatever mode
is saved there — so every reboot (USB reconnect, reset, vendor control transfer)
brings it back as 0x14db until that NVM value is changed.

#### What does NOT work

| Attempt | From PID | Result |
|---------|----------|--------|
| USB vendor control (0x40/0xA1) | 0x14db | RESET only → comes back as 0x14db |
| USB vendor control (0x40/0xA1) | 0x1442 | RESET only → comes back as 0x14db |
| USB vendor control (0x40/0xA1) | 0x1f01 | RESET only → comes back as 0x14db |
| `/api/device/mode` mode=0/1/2 | 0x14db | Error **125002** (blocked in this firmware) |
| AT^U2DIAG? | 0x1442 vendor iface | Returns **ERROR** (not supported in stick mode) |
| AT^U2DIAG=256 + AT^RESET | 0x1442 vendor iface | No OK; AT^RESET → 0x1f01 → 0x14db |

The vendor control transfer from storage PIDs works in the sense that it reboots the
device, but the boot target is the stored AT^U2DIAG value — not a hardcoded 0x1566.
With AT^U2DIAG=0 in NVM, *any* reboot or reset lands back at 0x14db.

#### What works

**Via HiLink HTTP API (requires macOS to load the CDC-ECM driver):**

1. `GET /api/webserver/SesTokInfo` → session + CSRF token
2. `POST /api/user/login` with type-4 hashed password → login (get next CSRF from header)
3. `POST /api/device/mode` with `<mode>1</mode>` → device switches to 0x1566 ✓

If `/api/device/mode` returns 125002 (blocked):

4. `POST /CGI` with `<function>switchMode</function><switchType>0</switchType>`
   → device re-enumerates as **0x1442** (storage PID, not 0x1566 directly)

**Note on macOS CDC-ECM:** Although the docs previously stated CDC-ECM never works
on macOS Sequoia, in practice the macOS CDC-ECM driver *can* load — the HUAWEI_MOBILE
interface appeared as "Connected" after the device went through 0x1f01→0x14db. The
trigger for the driver loading is not fully understood. When it does load, direct
`curl http://192.168.8.1/api/...` works without the user-space libusb stack.

The ArConfig.dat pair `14db,1f01` describes a *different* E8372 firmware variant
that uses 0x14db as its normal HiLink mode (without AT). Our unit (E8372H-153)
uses 0x1566 as its HiLink mode and only produces 0x14db when AT^U2DIAG=0 is sent.
Its storage PID is **0x1442**, not 0x1f01.

## USB Interfaces (after switch to 0x1566)

9 interfaces total:

| Index | Class | Purpose | Endpoints |
|-------|-------|---------|-----------|
| 0 | 2 (CDC) sub 6 (ECM) | Ethernet control | 1 IN |
| 1 | 10 (CDC Data) sub 6 | Ethernet data | 1 IN, 1 OUT |
| 2 | 255 (Vendor) | **PCUI (AT commands)** | IN 0x83, OUT 0x02 |
| 3 | 255 (Vendor) | c_shell | IN 0x84, OUT 0x03 |
| 4 | 255 (Vendor) | a_shell | IN 0x85, OUT 0x04 |
| 5 | 255 (Vendor) | 3g_diag | IN 0x86, OUT 0x05 |
| 6 | 255 (Vendor) | gps | IN 0x87, OUT 0x06 |
| 7 | 255 (Vendor) | 4g_diag | IN 0x88, OUT 0x07 |
| 8 | 8 (Mass Storage) | SD card / virtual CD | IN 0x89, OUT 0x08 |

Port map confirmed via `AT^GETPORTMODE`:
```
TYPE: WCDMA: huawei,,ecm:0,pcui:1,c_shell:2,a_shell:3,3g_diag:4,gps:5,4g_diag:6,mass_two:7
```

### macOS notes

macOS has **no kernel driver** for class 255 (vendor-specific) interfaces. No
`/dev/tty*` devices are created. On Linux, the `option` driver would claim them.

**Solution for AT:** Use `UsbTransport` (libusb bulk I/O) directly. Interface 2
responds to AT commands via bulk endpoints 0x83 (IN) and 0x02 (OUT).

**CDC-ECM on macOS Sequoia:** The Huawei `MBBDataCardECMDriver_10_9.kext` bundled
with the HiLink desktop app is a 32-bit i386 Mach-O binary (2014). It cannot load
on macOS Catalina+ (64-bit kernel only). macOS's built-in CDC-ECM driver matches
the device and HUAWEI_MOBILE does appear in Network preferences — but whether it
reaches "Connected" state is unpredictable. Observed on 2026-03-03: after the device
went through the 0x1442 → 0x1f01 → 0x14db cycle, macOS loaded the driver and
HUAWEI_MOBILE showed "Connected", making 192.168.8.1 directly reachable via `curl`.
The trigger is not fully understood (possibly the 0x1f01 storage presentation causes
the driver to re-enumerate correctly). Assigning a static IP in 192.168.8.x/24 on
the interface may help when "Not connected" persists.

## AT Command Access

Works via `UsbTransport` with interface 2 (PCUI). 495 commands available (AT+CLAC).

### Connecting with cellary

```typescript
import { Modem, UsbTransport, huaweiProfile } from '@cellary/core'

const transport = new UsbTransport({
  vendorId: 0x12D1,
  productId: 0x1566,
  interfaceNumber: 2,
})

const modem = await Modem.open({ transport, profile: huaweiProfile })
```

### Module test results

All tested on real hardware (2026-03-01):

| Module | Method | Status | Result |
|--------|--------|--------|--------|
| device | info() | OK | E8372, FW 21.328.03.00.00, IMEI 359999990000006 |
| network | signal() | OK | -55 dBm (RSSI via +CSQ) |
| network | registration() | OK | roaming, LAC 003D, CellID 00278120 |
| network | operator() | OK | 28310 (UCOM Armenia) |
| sim | imsi() | OK | 250020000000000 |
| sim | iccid() | OK | 8900000000000000000F (requires Huawei profile) |
| sms | list("all") | OK | 15 messages decoded (Cyrillic + emoji) |
| ussd | send("*100#") | EMPTY | Returns empty string (see USSD notes) |
| voice | AT+CLCC | OK | Command accepted |
| capabilities | discover() | OK | 495 commands, full feature matrix |

### Extended signal (Huawei-specific)

```
AT^HCSQ? => "LTE",61,51,66,20
AT^SYSINFOEX => 2,3,1,1,0,6,"LTE",101,"LTE"
AT+CNUM => "","+79990000000",145
AT+COPS? => 0,2,"28310",7
AT+CREG? => 1,5 (roaming)
AT+CEREG? => 0,5 (roaming)
AT^CARDMODE => 2 (USIM)
AT+CPMS? => "SM",15,15,"SM",15,15,"SM",15,15
```

### USSD notes

`AT+CUSD=1,"*100#",15` returns OK but `+CUSD:` response is either empty or arrives
as a delayed URC. May be an issue with roaming USSD forwarding or with our USSD
module's response collection (it expects inline response, not async URC).

## SIM Toolkit (STK)

### What works

- `AT^STSF=1` -- STK enable: **OK**
- `AT^STSF?` -- returns `1,FFFFFFEF1F...,119` (enabled, terminal profile, alpha ID)
- `^STIN` URCs -- **received** (transparent commands like Send SMS)

### What does NOT work

- `AT^STGI=*` -- **CME ERROR 50** (Incorrect parameters) for all command types
- `AT^STGR=*` -- **CME ERROR 50** for all command types
- `AT^STGI=?` -- reports supported range **(0-12)**, not 3GPP tag values (33-37)
- APDU-level STK (TERMINAL PROFILE, FETCH, ENVELOPE via AT+CSIM) -- blocked

### Why

In HiLink mode, the **firmware is the sole STK terminal**. It:
- Handles all proactive commands internally
- Shows menus in the web UI (e.g., "YOTA MENU" with items)
- Leaks `^STIN` notifications to the AT port
- But blocks `^STGI` and `^STGR` (CME 50 = "incorrect parameters")

The AT port can **observe** STK activity but cannot **interact** with it.

### Huawei STK numbering

Huawei E8372 uses sequential numbering (0-12), NOT 3GPP BER-TLV tag values:

| Huawei Type | 3GPP Concept | Category |
|-------------|--------------|----------|
| 0 | Refresh | Transparent |
| 1 | Display Text | Interactive |
| 2 | Get Inkey | Interactive |
| 3 | Get Input | Interactive |
| 4 | Play Tone | Interactive |
| 5 | Select Item | Interactive |
| 6 | Send SMS | Transparent |
| 7 | Send SS | Transparent |
| 8 | Send USSD | Transparent |
| 9 | Setup Call | Transparent |
| 10 | Setup Idle Mode Text | Transparent |
| 11 | Setup Menu | Interactive |
| 12 | Setup Event List | Transparent |
| 254 | Session End | Special |

### cellary STK behavior

After the fix (2026-03-01):
- Transparent commands (6, 7, 8, 9) emit `'notification'` events instead of crashing
- Interactive commands (1, 2, 3, 5, 11) attempt `AT^STGI` normally
- On HiLink devices, interactive STGI will still fail (CME 50), emitting `'error'`

## Direct SIM Access (AT+CRSM)

SIM file reads work via `AT+CRSM`:

| File | ID | Command | Result |
|------|----|---------|--------|
| ICCID | 2FE2 | READ BINARY | 98000000000000000FF0 |
| IMSI | 6F07 | READ BINARY | 082905200000000000 |
| SPN | 6F46 | READ BINARY | "YOTA" |
| MSISDN | 6F40 | READ RECORD | +79990000000 |
| EF_DIR | 2F00 | READ RECORD | AID A0000000871002... (USIM) |
| UST | 6F38 | READ BINARY | STK service bit = 1 (available on SIM) |

`AT+CSIM` also works for basic APDU commands (SELECT, GET RESPONSE) using class
byte 0x00 (USIM). Class 0xA0 (legacy SIM) returns 6E 00 (wrong class).

STK APDU commands (class 0x80: TERMINAL PROFILE, FETCH, ENVELOPE) are blocked by
the firmware.

## Web UI (192.168.8.1)

Accessible after mode-switch when CDC ECM adapter appears in macOS.

- **Default login:** admin
- **Operator:** UCOM (Roaming on MTS 250-02)
- **Network:** LTE Band 7, 20 MHz
- **STK menu:** "YOTA MENU" with operator-specific items
- **Device info page:** shows IMEI, IMSI, ICCID, signal details, cell info
- **API:** XML-based REST at `http://192.168.8.1/api/...`

### HiLink API

The E8372 uses Huawei's standard HiLink HTTP API over CDC-ECM at `http://192.168.8.1/api/`.
For full protocol documentation (endpoints, authentication, error codes, mode switching),
see [../../protocols/hilink/README.md](../../protocols/hilink/README.md).

E8372-specific notes:
- **0x14db recovery:** `/api/device/mode` returns 125002 on fw 21.328.03.00.00; CGI
  fallback produces PID 0x1442 (storage intermediate), then USB vendor control boots
  to 0x1566. See `navigateToAtMode(E8372_STATE_CONFIG)` in `vendor/huawei/state.ts`.
- **CDC-ECM on macOS:** HUAWEI_MOBILE interface sometimes reaches "Connected"
  unpredictably. When it does, `curl http://192.168.8.1/api/...` works directly.
  See macOS notes in the USB Interfaces section above.

## cellary integration

The E8372 works with cellary via `UsbTransport` on interface 2 (PCUI, AT commands).
All modules work except STK interaction (firmware-owned) and USSD (needs investigation).

Requires `huaweiProfile` for correct ICCID command (`AT^ICCID?`). macOS requires
`sudo` for libusb access; no kernel serial driver exists for class 255 interfaces.

### Connecting

```typescript
import { Modem, UsbTransport, huaweiProfile } from '@cellary/core'

// Direct connection (device already in 0x1566 mode)
const transport = new UsbTransport({ vendorId: 0x12D1, productId: 0x1566, interfaceNumber: 2 })
const modem = await Modem.open({ transport, profile: huaweiProfile })

// Auto-detect (handles storage→modem mode switch automatically)
const modem = await Modem.detect()
```

### Switching from HiLink (0x14db) back to AT mode (0x1566)

If the device was put into pure HiLink mode via `AT^U2DIAG=0`:

```typescript
import { scan, switchModemToAtMode, prepare } from '@cellary/core'

const [device] = scan()  // finds { mode: 'http', productId: 0x14db, url: '...' }
const atModem = await switchModemToAtMode(device)  // switches to 0x1566
const result = await prepare(atModem)
const modem = await Modem.open(result)
```

`switchModemToAtMode()` tries in order:
1. USB vendor control transfer (0x40/0xA1) — no network needed, instant
2. HiLink HTTP API at device URL — requires CDC-ECM interface up (192.168.8.1 reachable)

To switch the reverse direction (AT → HiLink, i.e. 0x1566 → 0x14db):
```typescript
await modem.execute('AT^U2DIAG=0')
// device will disconnect and re-enumerate as 0x14db
```

### Known issues / open items

- **+CREG never includes AcT** — same as E3372. Even with AT+CREG=2, access
  technology is absent from both queries and URCs. `AT+COPS?` and `AT^HCSQ` are
  the reliable alternatives. See [Huawei AT Command Compliance Issues](../../README.md#at-command-compliance-issues).
- **USSD:** `AT+CUSD` returns OK but response is empty or arrives as delayed async
  URC. Likely roaming issue or response timing mismatch in USSD module.
- **CDC-ECM on macOS Sequoia:** HUAWEI_MOBILE sometimes reaches "Connected" and
  sometimes doesn't — the trigger is not fully understood. When "Not connected",
  the HTTP path in `switchModemToAtMode()` is unavailable. Assigning a static IP
  in 192.168.8.x/24 on the interface may help. See macOS notes section above.
- **STK interaction:** firmware owns the STK terminal in HiLink mode; `^STGI`/`^STGR`
  return CME ERROR 50.

## ADB Access (Balong Linux)

See [../../balong/README.md](../../balong/README.md) for full Balong platform
documentation: OS details, AT bridge protocol, filesystem layout, available
commands, NV storage, iptables, and capabilities.
