# cellary macOS USB Mode Switch Driver

A DriverKit extension (DEXT) that automatically switches USB cellular modems from
storage mode (virtual CD-ROM) to modem mode on macOS.

## Why this exists

USB modems ship in "storage mode" — they present as a virtual CD-ROM drive containing
Windows/macOS driver installers. Before the modem can be used, a vendor-specific SCSI
command must be sent to trigger USB re-enumeration into modem mode.

On Linux, `usb_modeswitch` handles this via `libusb` after detaching the kernel driver.
**On macOS, this is impossible from userland** — the IOUSBMassStorageDriver holds exclusive
access to the device, and macOS does not allow kernel driver detach from userspace (SIP).

Every approach fails:
- `libusb iface.claim()` → `LIBUSB_ERROR_OTHER` (driver holds exclusive access)
- `sg_raw` (SCSI pass-through) → `Operation not permitted`
- `diskutil eject` → sends standard SCSI eject, not vendor-specific mode switch command
- Vendor control transfers via `libusb` → corrupts device firmware state

The only solution: intercept the device **before** the mass storage driver loads.
That's what this DriverKit extension does.

## How it works

```
USB device plugged in (storage mode, e.g. Huawei 0x12D1:0x1C0B)
         |
         v
    IOKit matching
         |
    +----+----+
    |         |
    v         v
  DEXT       IOUSBMassStorageDriver
  (score     (no explicit score,
   5000)      interface-level match)
    |
    v
  DEXT wins (higher score, device-level match)
    |
    v
  Opens device, finds mass storage interface
    |
    v
  Sends vendor SCSI CBW via bulk OUT endpoint
  (Huawei: CDB 0x11 0x06, ZTE: control 0x40/0xA1)
    |
    v
  Device re-enumerates with modem PID
  (e.g. 0x1C05 for Huawei, 0x0031 for ZTE)
    |
    v
  DEXT auto-unloads (PID no longer matches)
    |
    v
  cellary daemon claims modem via libusb — no conflicts
```

## Supported devices

| Vendor | VID | Storage PIDs | Mode switch method |
|--------|-----|-------------|-------------------|
| Huawei | 0x12D1 | 0x14FE, 0x1F01, 0x1F02, 0x157D, 0x158B, 0x1446, 0x1001, 0x1C0B | SCSI CBW (CDB 0x11 0x06) |
| ZTE | 0x19D2 | 0x2000, 0x0053 | USB vendor control (0x40/0xA1) |

Adding a new device: add a personality to `Driver/Info.plist`, a VID/PID pair to
`Driver/Driver.entitlements`, and a case to `sendModeSwitchCommand()` in the `.cpp` file.

## Project structure

```
packages/macos-driver/
  App/
    CellaryDriverApp.swift    # SwiftUI container app (installs/activates DEXT)
    App.entitlements          # system-extension.install entitlement
  Driver/
    CellaryModeSwitcher.iig    # C++ interface definition (IIG format)
    CellaryModeSwitcher.cpp    # Mode switch implementation
    Driver.entitlements       # DriverKit + USB transport entitlements
    Info.plist                # IOKitPersonalities (VID/PID matching)
  README.md
```

## Development setup

### Prerequisites

- macOS 13+ (Ventura or later)
- Xcode 15+
- Apple Developer account (for DriverKit entitlements)

### Creating the Xcode project

The source files are ready — you need to create an Xcode project that references them.

1. **Open Xcode** > File > New > Project

2. **Create the container app target:**
   - Template: macOS > App
   - Product Name: `CellaryDriver`
   - Team: your Apple Developer team
   - Bundle Identifier: `com.cellary.driver`
   - Language: Swift, Interface: SwiftUI
   - Location: `packages/macos-driver/`

3. **Add the DriverKit target:**
   - File > New > Target
   - Template: macOS > DriverKit Driver
   - Product Name: `ModeSwitcher`
   - Bundle Identifier: `com.cellary.driver.ModeSwitcher`
   - Language: C++

4. **Replace generated files with ours:**
   - Delete the auto-generated `.iig`, `.cpp`, `Info.plist`, and entitlements
   - Add our files from `Driver/` to the DriverKit target
   - Add our files from `App/` to the app target
   - Set the app's entitlements to `App/App.entitlements`
   - Set the driver's entitlements to `Driver/Driver.entitlements`

5. **Configure build settings:**
   - Driver target > Build Settings > "DriverKit" should already be set by template
   - App target > Build Phases > Embed System Extensions > add the driver target
   - App target > Signing & Capabilities > set Team and enable "System Extension"

6. **Frameworks:**
   - Driver target: ensure `DriverKit.framework` and `USBDriverKit.framework` are linked
   - App target: ensure `SystemExtensions.framework` is linked

### Testing without Apple entitlements (development only)

For local development, disable SIP to skip entitlement validation:

1. Restart Mac, hold `Cmd+R` (Intel) or power button (Apple Silicon) for Recovery Mode
2. Terminal > `csrutil disable`
3. Restart
4. Build and run from Xcode — DEXT activates without Apple-provisioned entitlements
5. **Re-enable SIP when done:** Recovery Mode > `csrutil enable`

With SIP disabled, the user-approval step is also skipped.

### Testing with SIP enabled (production-like)

1. Request DriverKit entitlements from Apple: https://developer.apple.com/system-extensions/
2. Create a provisioning profile that includes DriverKit entitlements
3. Build, sign, and run — macOS will prompt for user approval
4. Approve in System Settings > General > Login Items & Extensions

### Verifying the DEXT

```bash
# Check if DEXT is loaded
systemextensionsctl list

# Watch IOKit matching (plug in a modem)
log stream --predicate 'sender == "CellaryModeSwitcher"'

# Check USB device PID change
ioreg -r -c IOUSBHostDevice -l -w0 | grep -A5 "HUAWEI"
```

## Production distribution

For distribution outside the Mac App Store:

1. Request and receive DriverKit entitlements from Apple
2. Sign with Developer ID certificate
3. Notarize the app (`xcrun notarytool submit`)
4. Distribute as `.dmg` or `.pkg`

For Mac App Store distribution: DriverKit extensions are supported.

## Architecture decisions

### Why device-level matching (not interface-level)?

IOUSBMassStorageDriver matches on interface-level (`bInterfaceClass: 8`). By matching
on device-level (`IOUSBHostDevice` with `idVendor` + `idProduct`), we claim the entire
device before IOKit even exposes individual interfaces. This guarantees no race condition
with the mass storage driver.

### Why a dedicated app instead of embedding in the daemon?

System extensions must be distributed inside a macOS app bundle. The daemon runs as a
background process without an app bundle. A separate lightweight app handles installation;
once activated, the DEXT runs independently — the app doesn't need to stay open.

### Why C++ for the driver?

Apple requires DriverKit extensions to be written in C++ using the IIG (Interface
Implementation Generator) tool. Swift is not supported for DriverKit code. The container
app (which just activates the DEXT) is written in Swift.
