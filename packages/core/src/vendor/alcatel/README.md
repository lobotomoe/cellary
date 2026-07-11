# Alcatel (TCL) Vendor Module

## Device: Alcatel LINKZONE MW45V (Ucom uFi MW45V)

Pocket MiFi router, branded by UCOM Armenia. Model label: "Main - HT - A - 2228".

### Hardware

| Field | Value |
|-------|-------|
| VID:PID | 1BBB:0908 (modem mode, no storage mode PID) |
| Product Name | "Mobilebroadband" (USB descriptor) |
| Device Name | "Ucom uFi MW45V" (configAuto.titleValue) |
| Form factor | Pocket WiFi hotspot with battery (2150mAh) |
| LTE | Cat4, 150/50 Mbps |
| WiFi | 802.11 b/g/n 2.4GHz, 2x2 MIMO, up to 15 clients |
| Chipset | Likely Qualcomm MDM9207 (unconfirmed, based on similar LinkZone models) |
| Country | Armenia (DefaultCountry: "AM") |
| Languages | Armenian, English, Russian |
| IMEI | 359999990000006 |
| MAC | c8:2a:f1:35:a0:cb |
| FW | 01005, HW: MW45-V-V1.0, WebUI: MW45_JRDRESOURCE_NY_05_NA |

### USB Interface Layout (hardware-verified, macOS Sequoia)

| IF# | Class | SubClass | Protocol | Description |
|-----|-------|----------|----------|-------------|
| 0 | 2 (Comm) | 6 (ECM) | 0 | CDC Ethernet Control Model |
| 1 | 10 (CDC Data) | 0 | 0 | ECM Data (pair to IF0) |
| 2 | 8 (Mass Storage) | 6 (SCSI) | 80 (BBB) | Virtual CD-ROM |

**No ACM serial ports. No AT command interface over USB.**

### Network (USB tethering)

- macOS creates `en13` interface via AppleUserECM driver
- DHCP from device does NOT work (no response)
- Manual IP assignment needed: `192.168.1.x/24` subnet
- Gateway: `192.168.1.1` (responds to ping, serves web UI)
- Note: device does NOT use `192.168.8.x` (that's Huawei HiLink)

To set up USB access without losing WiFi internet:
```bash
sudo ifconfig en13 alias 192.168.1.100 netmask 255.255.255.0
# Now 192.168.1.1 is reachable via USB, WiFi stays on primary route
```

### Web Management Interface

- URL: `http://192.168.1.1/` (redirects to `/index.html`)
- Default credentials: admin / admin (UCOM unit has custom password, unknown)
- Accessible via both WiFi and USB (once IP is configured)

### API: TCL JRD JSON-RPC over HTTP

Endpoint: `POST http://192.168.1.1/jrd/webapi?api=<MethodName>`

Content-Type: `application/json`

Request body format:
```json
{
  "jsonrpc": "2.0",
  "method": "MethodName",
  "params": null,
  "id": "1"
}
```

#### Authentication

Two config flags control auth behavior:
- `IsVerifyToken: false` -- token verification via getToken() is DISABLED
- `IsEncryptionAndToken: true` -- Login params use XOR + MD5 encryption

**For unauthenticated (whitelist) requests, two headers required:**
```
_TclRequestVerificationKey: KSDHSDFOGQ5WERYTUIQWERTYUISDFG1HJZXCVCXBN2GDSMNDHKVKFsVBNf
Referer: http://192.168.1.1/
```
No `_TclRequestVerificationToken` needed, but the same-origin `Referer` IS
required -- without it even whitelist calls return `-32697 Authentication
Failure` (hardware-verified on FW 01005; the key alone is not enough).

**Important HTTP quirks:**
- Server emits bare-LF HTTP responses (`\n`, not `\r\n`). Node's `http` parser
  and undici (`fetch`) both reject these; cellary reads the raw TCP socket and
  parses with its own lenient `parseHttpResponse`. (`insecureHTTPParser` is not
  sufficient on modern Node.)
- Server does NOT support keep-alive reliably -- use `Connection: close`
- Rate limit on login: ~4 attempts, then "Login times is used out"

**For authenticated requests (login required):**

XOR encryption key: `"e5dl12XYVggihggafXWf0f2YSf2Xngd1"`

Login flow:
1. Call `Login` with `{ UserName: encrypt("admin"), Password: encryptMd("admin") }`
2. `encrypt(str)`: XOR cipher with key, produces 2 bytes per input char
3. `encryptMd(str)`: encrypt(str) then MD5 hash of the result
4. Response contains session token + params for encrypt_c() session key
5. Session token stored in cookie, used as `_TclRequestVerificationToken` for subsequent calls

#### Whitelist API (no login required)

These endpoints work with just the `_TclRequestVerificationKey` header.
Verified on our device -- responses documented below.

**Working (verified):**

| Method | Returns |
|--------|---------|
| GetSystemInfo | IMEI, ICCID, FW version, MAC, device name |
| GetNetworkInfo | PLMN, NetworkType, signal (RSSI/RSRP/SINR/RSRQ), band, cell info |
| GetConnectionState | IP, speed, traffic bytes, connection time |
| GetSimStatus | SIMState, PinState, remaining PIN/PUK attempts, SIM lock |
| GetSystemStatus | Battery, network summary, WiFi state, connected clients |
| GetSMSStorageState | Unread count, capacity, used count |

**Not tested yet:**
```
GetLoginState, HeartBeat,
GetSMSContactList, GetSMSContentList, GetSingleSMS,
GetSendSMSResult, GetSMSSettings,
GetConnectionSettings, GetNetworkRegisterState,
GetUsageRecord, GetUsageSettings,
GetDeviceNewVersion, GetDeviceUpgradeState,
GetLanSettings, GetConnectedDeviceList, GetBlockDeviceList,
GetCurrentLanguage, GetClientConfiguration, GetPowerSavingMode,
UnlockPin, UnlockPuk, UnlockSimlock
```

**Require login (error -32698):**
```
GetNetworkSettings, GetWlanState, GetWlanSettings,
GetWlanSupportMode, GetProfileList,
GetMacFilterSettings, getPortFwding, getDMZInfo,
getIPFilterList, getFirewallSwitch, getUrlFilterSettings,
GetUpnpSettings, getDNSInfo, GetWanAccess
```

#### Authenticated API (requires login)

```
Login, ForceLogin,
SendSMS, DeleteSMS, SaveSMS, SetSMSRead,
SetConnectionSettings, Connect, Disconnect,
SetNetworkSettings, SetWlanSettings,
SetLanguage, SetPasswordChangeFlag,
SetDeviceRestore, SetDeviceReboot,
SetCheckNewVersion
```

### Verified API Responses

#### GetSystemInfo
```json
{
  "SwVersion": "01005",
  "HwVersion": "MW45-V-V1.0",
  "WebUiVersion": "MW45_JRDRESOURCE_NY_05_NA",
  "HttpApiVersion": "TCL-HTTP",
  "DeviceName": "MW45V",
  "IMEI": "359999990000006",
  "ICCID": "8900000000000000000F",
  "MacAddress": "c8:2a:f1:35:a0:cb"
}
```

#### GetNetworkInfo
```json
{
  "PLMN": "00000",
  "NetworkType": 0,
  "NetworkName": "N/A",
  "SignalStrength": 0,
  "RSSI": "-49",
  "RSRP": "-1",
  "RSRQ": "-45",
  "SINR": "FF",
  "Band": 87,
  "Roaming": 1,
  "LTE_state": 0
}
```
Note: all zeros because SIM is locked (SIMState: 4).

#### GetSimStatus
```json
{
  "SIMState": 4,
  "PinState": 3,
  "PinRemainingTimes": 3,
  "PukRemainingTimes": 3,
  "SIMLockState": 0,
  "SIMLockRemainingTimes": 10
}
```
SIMState 4 = PERSON_CHECK_REQ (SIM lock / network lock active).

#### GetConnectionState
```json
{
  "ConnectionStatus": 0,
  "IPv4Adrress": "0.0.0.0",
  "Speed_Dl": 0,
  "Speed_Ul": 0,
  "ConnectionTime": 0,
  "UlBytes": 0,
  "DlBytes": 0
}
```

#### GetSystemStatus
```json
{
  "chg_state": 3,
  "bat_cap": 0,
  "bat_level": 0,
  "NetworkType": 0,
  "NetworkName": "N/A",
  "Roaming": 1,
  "SignalStrength": 0,
  "ConnectionStatus": 0,
  "WlanState": 1,
  "curr_num": 0,
  "TotalConnNum": 1
}
```

### SIM State Values (from sdk.js)

| Value | Constant | Meaning |
|-------|----------|---------|
| 0 | UNKNOWN | No SIM / unknown |
| 1 | DETECTED | SIM error |
| 2 | PIN1_OR_UPIN_REQ | PIN required |
| 3 | PUK1_OR_PUK_REQ | PUK required |
| 4 | PERSON_CHECK_REQ | SIM lock (network lock) |
| 5 | PIN1_PERM_BLOCKED | PUK blocked, SIM invalid |
| 6 | ILLEGAL | Invalid SIM |
| 7 | READY | SIM ready |
| 11 | INITING | SIM initializing |

### Capabilities (from config)

| Feature | Supported |
|---------|-----------|
| SMS | Yes (send, receive, read, delete) |
| USSD | Yes (SupportUssd: 1) |
| Network mode selection | Auto, 3G only, 4G only, 3G/4G |
| PIN management | Yes |
| SIM lock | Yes (NCK 16 digits) |
| WiFi control | Yes |
| WPS | Yes |
| SD card | No |
| Phonebook | No |
| Firewall/NAT | Port forwarding only |
| FOTA | Yes |
| Battery | Yes (chg_state, bat_cap, bat_level) |
