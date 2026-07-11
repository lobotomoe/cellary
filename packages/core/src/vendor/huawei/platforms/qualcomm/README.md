# Qualcomm Platform

Huawei's pre-Balong 3G modems run on **Qualcomm** basebands (MSM62xx-class), not
HiSilicon Balong. This is a distinct platform, not a variant of Balong:

- No Linux/adb shell, no HiLink HTTP API
- No HDLC / BootROM (`AT^GODLOAD`) flash path -- firmware update is Qualcomm QDL/EDL
- Diag port speaks Qualcomm DIAG (QCDM), not Huawei's HDLC diag
- Mode switch is standard `usb_modeswitch` (SCSI CBW / vendor control)

The device's own Windows driver package names its install sections
`QcomDevice`/`QportInstall` (`ew_hwusbdev.inf`), confirming the Qualcomm lineage.

## Why this exists as a sibling of `balong/`

PID **0x1C05 is reused across both platforms**:

- On a Qualcomm E173, `0x1C05` is the normal 3-port serial modem mode.
- On a Balong stick (e.g. E3372 after `AT^GODLOAD`), `0x1C05` is HDLC download mode.

There is no reliable single-probe USB discriminator between the two. We resolve
the ambiguity in favour of a working modem: `0x1C05` defaults to modem/`stick`.
Balong download mode is entered by an explicit user-initiated flash action, so
the flasher knows its own state and does not depend on cold-probe detection.
See `lifecycle-detectors.ts` here and in `../balong/`.

## Models

| Model | Storage PID | Modem PID | Voice | Notes |
|-------|-------------|-----------|-------|-------|
| E173  | 0x1C0B      | 0x1C05    | yes   | Qualcomm MSM62xx, HSPA. Dedicated PC Voice port. |

Confirmed on: E173 (Mobile Partner 23.015 driver package, PID 0x1C0B -> 0x1C05).
