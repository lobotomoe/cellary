# ZTE USB Modems

Vendor-level notes for ZTE USB modems. Device-specific details live in model subdirectories.

## Tested Models

| Model | Firmware | Chipset | Notes |
|-------|----------|---------|-------|
| [MF656](models/mf656/) | BD_MF656V1.0.2B11 | Qualcomm MSM | 3G WCDMA stick, vendor-class USB |

## USB Mode Switch

ZTE modems start as a virtual CD-ROM with autorun installer. The mode switch
mechanism differs significantly between platforms.

### Product IDs

| PID | Mode | Condition |
|-----|------|-----------|
| 0x2000 | Storage (CD-ROM + autorun) | Default, `AT+ZCDRUN=9` |
| 0x0053 | Storage (plain, no autorun) | After `AT+ZCDRUN=8` |
| 0x0031 | Modem (composite) | After mode switch. Sticky across power cycles |

### macOS: vendor control transfer (reversed from kext)

On macOS, SCSI bulk transfers to PID 0x2000 **timeout** because IOKit doesn't
load a mass storage driver for the device. The interface is "matched" in ioreg
but has no children -- no disk device, no endpoint pipe initialization.

ZTE's official macOS solution uses `ZTEUSBMassStorageFilter.kext` (probe score
92000, matches all ZTE mass storage interfaces). The kext:

1. Blocks Apple's `IOUSBMassStorageClass` via `kDoNotClassMatchThisInterface`
2. Sends USB vendor control `bRequest=0xA1` to trigger mode switch
3. Device re-enumerates as PID 0x0031

The vendor control is a **device-level** transfer -- no interface claim, no bulk
endpoints. It works without the kext because USB control pipe (EP0) is always
available:

```
bmRequestType: 0x40 (vendor, host-to-device, device)
bRequest:      0xA1
wValue:        0x0000
wIndex:        0x0000
wLength:       0
```

Source: reversed from `ZTEUSBMassStorageFilter.kext` binary (string
`cDeviceConfiguration:(%c:%d),SendA1:%d`) extracted from `MTS Connect.mpkg`
on the ZTE virtual CD-ROM.

The companion `Mac_SwapperDemon` userspace daemon uses a slightly different
approach: vendor control `bRequest=0xA0` + `FSEjectVolumeSync()` (macOS
volume eject API). This requires the kext to be installed (creates a disk
device to eject).

### Linux: SCSI StandardEject + vendor SCSI 0x85

On Linux, `usb-storage` kext properly initializes endpoint pipes, so SCSI
bulk transfers work. The `usb_modeswitch` config for `19d2:2000` uses:

1. `StandardEject=1` -- SCSI ALLOW MEDIUM REMOVAL + START STOP UNIT (LoEj=1)
2. `MessageContent` with vendor SCSI opcode `0x85`:
   ```
   CDB: 85 01 01 01 18 01 01 01 01 01 00 00
   ```

### macOS bulk transfer deep dive

Why SCSI doesn't work on macOS for PID 0x2000:

| Step | PID 0x2000 | PID 0x0053 |
|------|-----------|-----------|
| IOKit matching | matched, NO children | matched, full driver chain |
| `/dev/disk` created | no | yes |
| `setAutoDetachKernelDriver` | needed for claim() | needed for claim() |
| `iface.claim()` | OK (USBInterfaceOpenSeize) | OK |
| Bulk OUT transfer | **TIMEOUT (5s)** | OK (1ms) |
| USB control transfer | **OK** | OK |

The difference: PID 0x0053 (plain storage) gets a full IOKit driver chain
that initializes endpoint pipes. PID 0x2000 (autorun CD-ROM) gets matched
but the driver can't communicate with the device's non-standard SCSI
firmware -- no pipe initialization.

### ZCDRUN autorun commands

| Command | Effect |
|---------|--------|
| `AT+ZCDRUN=4` | Query autorun state (0=OFF, 1=ON) |
| `AT+ZCDRUN=8` | Disable autorun. Device uses PID 0x0053 on next plug |
| `AT+ZCDRUN=9` | Enable autorun. Device uses PID 0x2000 on next plug |
| `AT+ZCDRUN=E` | Factory reset |

**Warning:** `AT+ZCDRUN=8` writes to NV memory. PID 0x0053 has no AT
interface -- recovery requires modem-mode access (Linux or libusb IF1 on
PID 0x0031).

### Mode switch persistence

Once switched to PID 0x0031, the device **stays in modem mode across power
cycles**. Unplugging and re-plugging does not reset to storage mode.
With autorun=ON, the device appears directly as 0x0031 after replug.

## USB Interface Layout (MF656, PID 0x0031)

All communication interfaces use **bInterfaceClass=0xFF** (vendor-specific).
This means no OS serial driver claims them -- must use libusb direct bulk access.

| Interface | Class | Endpoints | Function |
|-----------|-------|-----------|----------|
| IF0 | 0xFF (vendor) | 2 bulk | Diagnostics/DIAG (no AT response) |
| IF1 | 0xFF (vendor) | 2 bulk | **AT command port (primary)** |
| IF2 | 0x08 (storage) | 2 bulk | MicroSD card reader |
| IF3 | 0xFF (vendor) | 2 bulk + 1 interrupt | AT command port (secondary) |

**Why generic discovery fails:** The CDC ACM fallback probe looks for
bInterfaceClass=0x02 (Communications). ZTE's vendor-class interfaces are
invisible to it. Database entries are required for discovery.

## AT Command Notes

- **Echo enabled by default** -- kept on (`ATE1`) so the channel can resync after a timeout
- **ICCID:** `AT+ICCID` (returns `ICCID: <value>`). `AT+CCID`, `AT+ZGETICCID`, `AT+QCCID` are not supported
- **Network type:** `AT+ZPAS?` returns service and domain (e.g. `"EDGE","CS_PS"`)
- **Signal:** Standard `AT+CSQ` works. `+ZRSSI` URC fires on signal change
- **Network selection:** `AT+ZSNT` for network type preference (2G/3G/auto)

## Vendor URCs

| URC | Meaning |
|-----|---------|
| `+ZPAS` | Service status change (e.g. `"3G","CS_PS"`) |
| `+ZUSIMR` | SIM status change |
| `+ZDONR` | Domestic roaming notification |
| `+ZPASR` | Service status report |
| `+ZEND` | Call end |
| `$QCSIMSTAT` | Qualcomm SIM status (from MSM chipset) |
| `$CREG` | Qualcomm registration |
| `$QCSYSMODE` | System mode change |

## Capabilities (from AT+CLAC)

Full AT+CLAC dump available. Notable supported commands:
- SMS: +CMGS, +CMGR, +CMGL, +CMGD, +CNMI, +CMGF
- Voice: ATD, ATA, ATH, +CHUP, +CLCC, +DTMF, +VTS
- Network: +COPS, +CREG, +CGREG, +CSQ
- SIM: +CPIN, +CIMI, +ICCID
- USSD: +CUSD
- Data: +CGDCONT, +CGACT, +CGATT
- Call forwarding: +CCFC
- STK: +STKPRO, +STKTR, +STKENV (SIM Toolkit present)

## macOS-Specific Notes

- **sudo required** for libusb access (`NeedsDeviceAccessEntitlement = Yes`)
- **`setAutoDetachKernelDriver(true)` required** before `iface.claim()`,
  even when ioreg shows "no kernel driver active". Without it: `LIBUSB_ERROR_ACCESS`
- **SCSI endpoint STALL halts all subsequent transfers** -- must `clearHalt()`
  on both endpoints after any STALL before sending more commands
- **Bootstrap detection**: `launchctl managername` returns `Aqua` (user/Terminal)
  or `Background` (system daemon). Relevant for daemon mode switch delegation.
