# Huawei HiLink HTTP API

HiLink is Huawei's XML-over-HTTP management API embedded in modem firmware.
It runs on the device itself (not a cloud service) and is served over the
CDC-ECM Ethernet interface at `http://192.168.8.1/api/`.

Tested on: E8372H-153 fw 21.328.03.00.00.

## Session / CSRF

Every request chain starts with a session fetch:

```
GET /api/webserver/SesTokInfo
```

Response:

```xml
<SesInfo>SessionID=abc123</SesInfo>   <!-- Cookie header value -->
<TokInfo>deadbeef1234</TokInfo>       <!-- __RequestVerificationToken header value -->
```

**CSRF token rotation:** each POST response carries the next CSRF token in the
`__RequestVerificationToken` response header as `tok1#tok2#...`. Use the first
segment for the immediately following request. Never cache tokens across requests.

## Authentication

Most monitoring endpoints work without authentication. Sensitive endpoints
return error 100003 and require login first.

### Login

```
POST /api/user/login
Cookie: <SesInfo>
__RequestVerificationToken: <TokInfo>
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<request>
  <Username>admin</Username>
  <Password><hashed></Password>
  <password_type>4</password_type>
</request>
```

**Password type 4 hash formula** (confirmed on E8372H-153 fw 21.328.03.00.00):

```
inner_hex  = hex(sha256(password))                        ← lowercase hex string
inner_b64  = base64(inner_hex)                            ← base64 of the hex string
outer_hex  = hex(sha256(username + inner_b64 + csrf_token))
result     = base64(outer_hex)
```

Both SHA-256 outputs are hex-encoded before base64. Web Crypto API (`crypto.subtle`)
produces the correct output in both Node.js and browsers. See `hashHiLinkPassword()`
in `index.ts`.

On success, the response header `__RequestVerificationToken` carries the next CSRF token.
Error 108006 = account locked (too many failed attempts; counter is RAM-only,
resets on USB unplug).

## Endpoints: no authentication required

| Endpoint | Key response fields |
|----------|---------------------|
| `GET /api/monitoring/status` | ConnectionStatus, SignalIcon, CurrentNetworkType, RoamingStatus, SimStatus, WifiStatus |
| `GET /api/device/signal` | pci, cell_id, rsrp, rsrq, rssi, sinr, mode, lte_bandwidth, lte_bandinfo |
| `GET /api/net/current-plmn` | FullName, ShortName, Numeric (PLMN), Rat |
| `GET /api/net/net-mode` | NetworkMode, NetworkBand, LTEBand |
| `GET /api/wlan/basic-settings` | WifiSsid, WifiChannel, WifiCountry, WifiMode, WifiEnable |
| `GET /api/sms/sms-count` | LocalUnread, LocalInbox, SimUnread, SimMax, LocalMax |
| `GET /api/sms/send-status` | Phone, SucPhone, TotalCount, CurIndex |
| `GET /api/monitoring/traffic-statistics` | TotalUpload, TotalDownload, CurrentUpload, CurrentDownload, TotalConnectTime |
| `GET /api/dialup/connection` | ConnectMode, MTU, auto_dial_switch, pdp_always_on |
| `GET /api/pin/status` | SimState, PinOptState, SimPinTimes, SimPukTimes |
| `GET /api/ussd/status` | result (0 = idle) |
| `GET /api/monitoring/check-notifications` | UnreadMessage, SmsStorageFull |

Sample `/api/device/signal` response (E8372H-153, LTE Band 7):

```xml
<pci>96</pci>
<cell_id>2588959</cell_id>
<rsrp>-87dBm</rsrp>
<rsrq>-13dB</rsrq>
<rssi>-53dBm</rssi>
<sinr>-1dB</sinr>
<mode>7</mode>              <!-- 7 = LTE -->
<lte_bandwidth>20M</lte_bandwidth>
<lte_bandinfo>7</lte_bandinfo>  <!-- Band 7 = 2600 MHz -->
```

### SimState values (`/api/pin/status`)

| Value | Meaning |
|-------|---------|
| 256 (0x100) | SIM absent |
| 257 (0x101) | SIM ready (no PIN required) |
| 258 (0x102) | PIN required |
| 259 (0x103) | PUK required |

### ConnectionStatus values (`/api/monitoring/status`)

| Value | Meaning |
|-------|---------|
| 901 | Data connected |
| 902 | Data disconnected (standard) |
| 113 | Data not connected (firmware-specific; observed on E8372H-153 when PDP not established) |

### Undocumented endpoints (no auth)

| Endpoint | Content |
|----------|---------|
| `GET /dev_info.data` | Chip temperature, device code, hardware version (JSON-ish) |
| `GET /html/antenna.html` | Antenna signal display page |
| `GET /html/antenna1.html` | Alternative antenna page |

### Device control (auth required)

| Endpoint | Content |
|----------|---------|
| `POST /api/device/control` | Device power control (shutdown, reboot) |

## Endpoints: authentication required (100003)

| Endpoint | Content |
|----------|---------|
| `GET /api/device/information` | IMEI, ICCID, firmware version, hardware version |
| `POST /api/sms/sms-list` | inbox/outbox listing |
| `GET /api/wlan/host-list` | connected WiFi clients |
| `GET /api/dialup/profiles` | APN profiles |

SMS list request body:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<request>
  <PageIndex>1</PageIndex>
  <ReadCount>20</ReadCount>
  <BoxType>1</BoxType>         <!-- 1=inbox 2=outbox 3=draft -->
  <SortType>0</SortType>
  <Ascending>0</Ascending>
  <UnreadPreferred>0</UnreadPreferred>
</request>
```

## Error codes

| Code | Meaning |
|------|---------|
| 100001 | Bad request / wrong HTTP method |
| 100002 | Endpoint not registered on this firmware |
| 100003 | Authentication required |
| 100005 | Missing or invalid request parameters |
| 108006 | Account locked (too many failed logins; RAM-only, resets on USB unplug) |
| 125001 | Wrong CSRF token |
| 125002 | Endpoint blocked by firmware policy |

## Mode switching

To switch the device from HiLink-only mode back to HiLink+AT mode, the API
provides two paths tried in order:

### 1. `/api/device/mode` (preferred)

```
POST /api/device/mode
Cookie: <SesInfo>
__RequestVerificationToken: <TokInfo>
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<request><mode>1</mode></request>
```

Returns error 100003 if auth is required (login first, then retry).
Returns error 125002 if blocked by this firmware — fall back to CGI.

### 2. Legacy CGI endpoint (fallback)

Used when `/api/device/mode` returns 125002:

```
POST /CGI
Cookie: <SesInfo>
__RequestVerificationToken: <TokInfo>
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<api version="1.0">
  <header><function>switchMode</function></header>
  <body><request><switchType>0</switchType></request></body>
</api>
```

Bash example:

```bash
RESP=$(curl -s http://192.168.8.1/api/webserver/SesTokInfo)
SES=$(echo "$RESP" | sed -n 's/.*<SesInfo>\(.*\)<\/SesInfo>.*/\1/p')
TOK=$(echo "$RESP" | sed -n 's/.*<TokInfo>\(.*\)<\/TokInfo>.*/\1/p')

curl -s -X POST http://192.168.8.1/CGI \
  -H "Cookie: $SES" \
  -H "__RequestVerificationToken: $TOK" \
  -H "Content-Type: text/xml" \
  -d '<?xml version="1.0" encoding="UTF-8"?><api version="1.0"><header><function>switchMode</function></header><body><request><switchType>0</switchType></request></body></api>'
```

**E8372H-153 fw 21.328.03.00.00 behavior:** `/api/device/mode` returns 125002.
The CGI path produces **PID 0x1442** (storage intermediate), not 0x1566 directly.
A subsequent USB vendor control transfer (0x40/0xA1) from 0x1442 boots to 0x1566.

See `requestHiLinkModeSwitch()` in `index.ts` for the full fallback logic with
CSRF token threading. For complete state navigation including USB vendor control:
`vendor/huawei/state.ts -> navigateToAtMode()`.

## Reverse Engineering: Huawei HiLink macOS Desktop Software

Source: `HiLink.app` extracted from E8372H-153 storage partition (PID 0x1F01).
Multi-model software -- ArConfig.dat and kext cover E3xxx/E8xxx and other HiLink devices.
All binaries are Mach-O i386, built with Xcode 4.6.3 on macOS 10.8 SDK.
Build environment: `/Users/hw/Desktop/MacAutoRun/MBBService/`

### Architecture

```
HiLink.app (installer/launcher, 42KB)
  +-- mbbservicePkg.app        -> installs mbbservice daemon
  +-- mbbserviceSetup.pkg      -> installs kext + launchd plist
  |     +-- mbbservice         -> background daemon (165KB, 6 C modules)
  |     +-- ArConfig.dat       -> device PID config
  |     +-- com.huawei.mbbservice.plist -> launchd (RunAtLoad, always-on)
  |     +-- MBBDataCardECMDriver_10_9.kext -> CDC-ECM kernel extension
  |           +-- MBBAppUSBCDCECMControl.kext (USB interface 0)
  |           +-- MBBAppUSBCDCECMData.kext   (USB interface 1)
  +-- mbbserviceopen.app       -> browser launcher (runs as user, not root)
```

Source modules: `mainrun.c`, `detectdevice.c`, `openbrowser.c`,
`Process.c`, `ActiveVolumeProgram.c`, `INI.c`

### Key Finding

The `mbbservice` daemon does NOT use the HiLink HTTP API at all.
It is purely a USB lifecycle manager:
1. Detects USB devices via IOKit
2. Sends vendor control transfer to trigger mode switch
3. Finds the CDC-ECM network interface via IORegistry
4. Creates a macOS network service (Ethernet + DHCP)
5. Opens a browser to the web UI

All actual device management happens through the browser-based web UI.

### Device Lifecycle (DetectDevice function)

1. Parse ArConfig.dat PID pairs via `Parse_PID()` -- format: `modemPID,storagePID;...`
2. IOKit matching loop: `IOServiceGetMatchingServices` for vendor 0x12D1 + PID
3. Storage PID detected:
   - Poll up to 20x (200ms each) for CD-ROM BSD name
   - On macOS > 10.8: call `activateDevice()` (vendor control 0x40/0xA1)
   - On macOS <= 10.8: different path (possibly SCSI CBW)
4. After switch, poll up to 20x for modem BSD name
5. Modem PID detected:
   - `saveEntryMacAddressAndBSDName()` finds CDC-ECM interface
   - `pthread_create()` for network configuration
   - Signal browser launch

### USB Mode Switch (activateDevice -- confirmed)

```
bmRequestType = 0x40  (USB_DIR_OUT | USB_TYPE_VENDOR | USB_RECIP_DEVICE)
bRequest      = 0xA1
wValue        = 0x0000
wIndex        = 0x0000
wLength       = 0x0000
```

Before the control transfer: unmounts TF card, creates IOKit plugin,
gets USB device interface via QueryInterface, opens device, sends
DeviceRequest (vtable offset 0x68), closes and releases.

**Exactly matches our `HUAWEI_VENDOR_SWITCH` in `switch.ts`.**

### ECM Interface Discovery

Two code paths in `saveEntryMacAddressAndBSDName()`:
- macOS >= 10.10: looks for `AppleUSBCDCECMData` (Apple's built-in CDC-ECM)
- macOS < 10.10: looks for `MBBUSBCDCECMData` (Huawei's custom kext)

Apple added built-in CDC-ECM support in Yosemite (10.10), making the
Huawei kext obsolete on modern macOS.

### ArConfig.dat PID Database

**Modem PIDs:** 0x14DB 0x14DC 0x14DD 0x14D7 0x14D8 0x14D9 0x14DE 0x14DF
**Storage PIDs:** 0x1F01 0x1F02 0x157D 0x158B
**MBIM filter:** 0x157D 0x158B (dual-role: storage + MBIM capable)

Default gateway: `http://192.168.1.1` (differs from our E8372's `192.168.8.1`
-- firmware-dependent).

### CDC-ECM Kernel Extension PIDs

All PIDs with dedicated kext entries (all support HiLink HTTP API):

```
0x14BB  0x14BC  0x14BD  0x14BE  (E3xxx series)
0x14DB  0x14DC                  (E8372 HiLink-only, confirmed)
0x14F6  0x14F7  0x14F8  0x14F9  0x14FA
0x1575  0x1576  0x1578
0x1590
0x15BC  0x15BD  0x15BE  0x15BF
0x15C7  0x15C8
```

Parent driver matches ALL Huawei devices (`idVendor=4817`, no product filter).
Fallback matching by USB class: CDC-ECM Control (class 2/subclass 6) on
interface 0, CDC-ECM Data (class 10/subclass 6) on interface 1.
