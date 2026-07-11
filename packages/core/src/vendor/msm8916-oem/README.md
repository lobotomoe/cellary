# Qualcomm MiFi / UFI Platform

## Platform Overview

Chinese 4G USB WiFi dongles based on Qualcomm MSM8916 or MDM9207 chipsets.
Run Android 4.4 internally with MifiService.apk (Eclipse Jetty 8.x web server).

This is an **ODM platform**, not a single vendor. Dozens of brands sell
identical hardware with the same firmware: TianJie, UFI, UZ801, OLAX, etc.
The shared behavior is the platform, not the brand.

### Common Characteristics

- Qualcomm USB VID: `0x05C6`
- Default PID: `0xF00E` (RNDIS-only USB composition)
- USB product string: `"Android"`
- Internal OS: Android 4.4 (MifiService.apk, Eclipse Jetty 8.x)
- WiFi AP: SSID like `4G-UFI-xxxx`
- Management API: `POST http://192.168.100.1/ajax` with `{"funcNo": N}`
- Default credentials: admin/admin
- DNS: dnsmasq 2.51 on port 53

## USB Interface Layout

Default composition (PID `0xF00E`):

| Interface | Class        | Endpoints         | Purpose            |
|-----------|--------------|-------------------|--------------------|
| 0         | 0xE0/1/3     | Interrupt ep0x82  | RNDIS control      |
| 1         | 10 (CDC Data)| Bulk ep0x81 IN, ep0x01 OUT | RNDIS data |

### USB Compositions

| PID    | Functions              | Notes                         |
|--------|------------------------|-------------------------------|
| 0xF00E | RNDIS only (default)   | No ADB, no serial             |
| 0x9024 | RNDIS + ADB            | After enabling ADB            |
| 0x902C | RNDIS + DIAG           |                               |
| 0x902D | RNDIS + DIAG + ADB     |                               |
| 0x9008 | Qualcomm EDL           | Emergency download mode       |
| (funcNo=1022) | DIAG+AT+MODEM+RNDIS | Serial ports + RNDIS      |

PID is set by Android USB gadget config (`init.qcom.usb.rc`):
`sys.usb.config=rndis,none` -> PID F00E, `sys.usb.config=rndis,adb` -> PID 9024.

## RNDIS over USB (libusb, userspace)

### Protocol Sequence

1. **INITIALIZE** (control transfer 0x21/0x00 -> 0xA1/0x01): succeeds,
   MajorVersion=1, DeviceFlags=1 (connectionless)
2. **SET packet filter** (OID 0x0001010E, value 0x0B): succeeds
3. **QUERY MAC** (OID 0x01010101): succeeds, returns 6-byte MAC
4. **Start interrupt ep0x82 polling**: required, device sends
   RESPONSE_AVAILABLE (`01 00 00 00 00 00 00 00`)
5. **Bulk IN/OUT**: Ethernet frames wrapped in RNDIS_PACKET_MSG headers

### Verified Behavior (macOS, libusb via `usb` npm)

- RNDIS control channel: fully functional
- RNDIS bulk transfers: **functional when device is thermally stable**
- Bulk IN warm-up: ~10 seconds after RNDIS init before frames arrive
- RNDIS control MAC (`02:57:03:57:36:31`): randomized each boot
- Android internal MAC (`a0:87:22:d9:87:f7`): stable, used in Ethernet frames
- Device IP on RNDIS: `192.168.100.1`
- DHCP assigns host: `192.168.100.125/24`
- IPv6: device sends multicast (link-local, MLDv2 reports)
- ARP: device probes for DHCP-assigned host IP on RNDIS init

### TCP Port Scan (confirmed on TianJie U800-3)

| Port | Status | Service                       |
|------|--------|-------------------------------|
| 80   | OPEN   | Eclipse Jetty 8.x (HTTP API)  |
| 53   | OPEN   | dnsmasq 2.51 (DNS)            |
| 8080 | RST    | closed                        |
| 5555 | RST    | closed (no ADB)               |
| 7628 | RST    | closed (no ADB)               |
| 443  | RST    | closed                        |
| 22   | RST    | closed (no SSH)               |
| 23   | RST    | closed (no telnet)            |

**Port 80 IS open on RNDIS.** Full TCP handshake confirmed:
SYN -> SYN+ACK -> ACK -> HTTP request (185B) -> HTTP response (308B) -> FIN.
The web server binds to all interfaces including rndis0.

Earlier RST results on port 80 were due to **boot timing**: RNDIS interface
comes up before Jetty starts. If you connect too early, port 80 returns RST.
On a subsequent boot (device already warm), port 80 connected instantly.

### HTTP over RNDIS — Community Evidence

Confirmed both by our testing and community sources:
- [OpenStick #16](https://github.com/OpenStick/OpenStick/issues/16):
  PID 0xF00E, port 80 (Jetty 8.x) and 53 (dnsmasq) open at 192.168.100.1
- [EFF Rayhunter](https://efforg.github.io/rayhunter/uz801.html):
  installer makes HTTP requests to `192.168.100.1/usbdebug.html` over USB RNDIS
- [nickvsnetworking](https://nickvsnetworking.com/adventures-with-a-10-lte-mifi-dongle/):
  web UI at 192.168.100.1, ADB enabled via `usbdebug.html`, all over USB

### Boot Timing

RNDIS stack readiness timeline (from cold boot):
1. USB device appears on bus: ~2-3s (red LEDs)
2. RNDIS control transfers work: immediately after USB enumeration
3. Bulk IN starts delivering frames: 0-10s (varies, sometimes instant)
4. ARP resolution succeeds: depends on bulk IN readiness
5. **Jetty web server ready**: variable — sometimes instant on warm boot,
   RST on cold boot if connected too early. Retry needed.
6. Device overheats and reboots: 1-2 minutes on USB hub power

### IP Address Variants

Different firmwares use different RNDIS subnets:

| Firmware variant    | WiFi AP IP      | RNDIS/USB IP      |
|---------------------|-----------------|-------------------|
| Stock (most)        | 192.168.100.1   | 192.168.100.1     |
| Stock (some)        | 192.168.100.1   | 192.168.0.1       |
| Webkey variant      | 192.168.43.1    | 192.168.43.1      |
| OpenStick/Debian    | 192.168.100.1   | 192.168.200.1     |

## Management API

Single endpoint: `POST http://192.168.100.1/ajax`

### API Variants

Two firmware generations exist with different endpoints:

| Variant | Endpoint           | Key field | Firmwares       |
|---------|--------------------|-----------|-----------------|
| V2      | `POST /ajax`       | `funcNo`  | V2.x (most)     |
| V1      | `POST /api/json`   | `fid`     | Older builds     |

V2 is the dominant variant on current hardware. V1 uses `/api/json` with
`fid` parameter and slightly different response shapes.

### Authentication

Login: `POST /ajax {"funcNo": 1000, "username": "admin", "password": "admin"}`

Returns a session token (`flag: "1"` on success). Token is passed via cookie
or header on subsequent requests.

**Important: authentication is cosmetic on V2 firmware.** Community decompilation
of MifiService.apk (theXappy) shows that most "authenticated" endpoints don't
actually validate the session token. The login flow exists but enforcement is
minimal. This matches our live testing (funcNo=1029 works without login).

Default credentials: `admin` / `admin` (hardcoded in firmware).

### funcNo Operations (Complete Reference)

Source: theXappy's MifiService.apk decompilation + live testing.

**Network & Status:**

| funcNo | Auth* | Description                                      |
|--------|-------|--------------------------------------------------|
| 1000   | No    | Login (username, password) -> session token       |
| 1001   | No    | Network status (signal, operator, technology)     |
| 1005   | No    | SIM status (inserted, PIN state)                  |
| 1029   | No    | Device info (IMEI, firmware, model, manufacturer) |
| 1030   | No    | Battery status (level, charging)                  |
| 1031   | No    | Data usage statistics                             |

**SMS:**

| funcNo | Auth* | Description                                      |
|--------|-------|--------------------------------------------------|
| 1002   | Yes   | SMS list (inbox)                                  |
| 1003   | Yes   | Send SMS (number, text)                           |
| 1004   | Yes   | Delete SMS (by index)                             |

**WiFi & Network Config:**

| funcNo | Auth* | Description                                      |
|--------|-------|--------------------------------------------------|
| 1010   | Yes   | WiFi encryption settings (password, security type)|
| 1011   | Yes   | WiFi SSID settings                                |
| 1012   | Yes   | WiFi advanced (channel, bandwidth)                |
| 1013   | Yes   | WiFi MAC filter settings                          |
| 1014   | Yes   | DHCP settings                                     |
| 1015   | Yes   | Connected WiFi clients list                       |

**Cellular & APN:**

| funcNo | Auth* | Description                                      |
|--------|-------|--------------------------------------------------|
| 1006   | Yes   | APN settings (read)                               |
| 1007   | Yes   | APN settings (write)                              |
| 1008   | Yes   | Network mode (2G/3G/4G preference)                |
| 1009   | Yes   | Network band selection                            |

**System & USB:**

| funcNo | Auth* | Description                                      |
|--------|-------|--------------------------------------------------|
| 1020   | Yes   | PIN management (enter/change/enable/disable)      |
| 1022   | Yes   | USB composition change (mode=1 -> DIAG+AT+MODEM)  |
| 1025   | Yes   | Factory reset                                     |
| 1026   | Yes   | Reboot device                                     |
| 2001   | Yes   | Enable ADB (device reboots with new USB PID)      |
| 2002   | Yes   | Firmware update                                   |
| 2003   | Yes   | Language settings                                 |
| 2004   | Yes   | Time zone settings                                |

*Auth column reflects the intended design. On V2 firmware, enforcement is
minimal — many "authenticated" endpoints respond without a valid session.

### WiFi Control Limitations

**funcNo=1010 changes WiFi password/encryption type only.** It does NOT
enable or disable the WiFi AP. There is no funcNo to disable WiFi.

To disable WiFi AP (for thermal mitigation):
1. Enable ADB: `POST /ajax {"funcNo": 2001}` or `GET /usbdebug.html`
2. Device reboots with PID 0x9024 (RNDIS + ADB)
3. Connect via ADB: `adb connect 192.168.100.1:7628` (or port 5555)
4. Disable WiFi: `adb shell svc wifi disable`

WiFi disable saves ~1W and significantly reduces thermal throttling.
The setting persists until reboot.

Alternative (persistent): edit `/system/etc/wifi/wpa_supplicant.conf` via ADB
to prevent WiFi from starting. Requires root (available on most stock firmwares).

### ADB Enablement

Two known paths:
- `POST /ajax {"funcNo": 2001}` (requires auth session)
- `GET /usbdebug.html` (some firmwares, no auth)

ADB port: **7628** (non-standard) on some variants, **5555** (standard) on others.
After enabling, device reboots with PID 0x9024 (RNDIS + ADB).

## Thermal Issues

MSM8916 SoC generates significant heat in the tiny USB stick form factor.

### Root Cause

- No thermal pads between SoC die and RF shield
- Full Android OS + cellular + WiFi AP in ~5cm stick
- SoC hits ~97C thermal shutdown threshold
- Stock firmware disables 2 of 4 CPU cores as mitigation

### Observed Behavior

- Boots: red LEDs
- Connects to cellular: blue + green LEDs
- Overheats: LEDs off, reboot (1-2 minute cycle on USB hub power)
- MAC address changes each reboot (RNDIS control MAC is randomized)

### Mitigations

1. **Thermal pads** (0.5mm between SoC and RF shield) — most effective, -15-20C
2. **External heatsink** on case
3. **Disable WiFi AP** (saves ~1W, significant heat reduction)
4. **USB extension cable** (separates from laptop heat)
5. **Powered USB hub** (stable power delivery)
6. **CPU frequency cap** via ADB: `echo 800000 > .../scaling_max_freq`

## Tested Models

### TianJie U800-3

- IMEI: 359999990000006
- SSID: 4G-UFI-7F7 / WiFi KEY: 1234567890
- USB: VID 0x05C6, PID 0xF00E
- Firmware: **V2.3.6** (confirmed via API)
- Manufacturer string: "Qualcomm Technology"
- RNDIS bulk: functional when thermally stable
- TCP port 80: OPEN (Jetty), port 53: OPEN (dnsmasq), all others RST
- Full HTTP API confirmed working over RNDIS (see below)
- Severe thermal issues on USB hub power

### API Responses (live, over RNDIS)

**funcNo=1029 (device info):**
```json
{
  "results": [{
    "manufacture": "Qualcomm Technology",
    "dbm": "",
    "fwversion": "V2.3.6",
    "imei": "359999990000006"
  }],
  "error_info": "none",
  "flag": "1"
}
```

**funcNo=1001 (network status):**
```json
{
  "results": [{
    "oper": "YOTA",
    "netstatus": "Disconnected",
    "netmode": "UNKNOWN",
    "rssi": 0
  }],
  "error_info": "none",
  "flag": "1"
}
```

Note: "Disconnected" because device had just rebooted and hadn't re-registered
on the network yet. On a stable device, `netstatus` should be "Connected"
with actual signal/mode data.

### API Response Format

All responses follow the same envelope:
```json
{
  "results": [{ ...payload... }],
  "error_info": "none",
  "flag": "1"
}
```

## Next Steps

1. Test authenticated endpoints (login -> SMS list, USB composition switch)
2. Implement retry logic for boot timing (port 80 RST on cold boot)
3. Thermal mitigation for sustained testing (thermal pads or disable WiFi)
4. Document full API response shapes for each funcNo

## Community Resources

- [u0d7i/uz801](https://github.com/u0d7i/uz801) — main UZ801 documentation
- [asvdvl/uz801-v3.0_stuff](https://github.com/asvdvl/uz801-v3.0_stuff) — v3.0 hardware, separate RNDIS subnet
- [theXappy/UZ801-LTE-USB-MODEM](https://github.com/theXappy/UZ801-LTE-USB-MODEM) — web server research
- [OpenStick/OpenStick](https://github.com/OpenStick/OpenStick) — Debian for MSM8916 dongles
- [EFF Rayhunter](https://github.com/EFForg/rayhunter) — IMSI catcher detector, uses this hardware
- [xiv3r/uz801-usb-pentest](https://github.com/xiv3r/uz801-usb-pentest) — pentest notes
- [4PDA MSM8916 thread](https://4pda.to/forum/index.php?showtopic=1060596) — Russian community
- [XDA MSM8916 thread](https://xdaforums.com/t/qualcomm-msm-8916-lte-4g-usb-modem-chinese-firmware.4407691/)
- [nickvsnetworking](https://nickvsnetworking.com/adventures-with-a-10-lte-mifi-dongle/) — teardown and testing
