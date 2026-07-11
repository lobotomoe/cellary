# UZ801 / MSM8916 4G USB Stick

## Hardware

- **SoC:** Qualcomm MSM8916 (quad-core ARM Cortex-A53, 1.2 GHz)
- **OS:** Android (internal, not user-facing)
- **Modem:** MDM9207 (integrated LTE Cat4)
- **Vendor ID:** 0x05C6 (Qualcomm)
- **Product IDs:**
  - RNDIS only: 0xF00E (default)
  - RNDIS + ADB: 0x9024 (after funcNo=2001)
  - EDL (brick): 0x9008
- **Management:** HTTP API at 192.168.100.1 (POST /ajax with funcNo)
- **Our unit:** TianJie U800-3, UZ801 v3.0 board

## Known Brand Variants

The same hardware is sold under many names. All share the same PCB design
(with minor revisions), same Qualcomm SoC, same firmware, and same USB protocol.

| Brand | Model | Board | Notes |
|-------|-------|-------|-------|
| TianJie | U800-3 | UZ801 v3.0 | Our test unit |
| UFI | UFI001B | UFI001B | Different PCB layout, same SoC |
| UFI | UFI001C | UFI001C | Updated UFI board |
| Generic | UZ801 | v2.0, v3.0, v3.2 | Board name printed on PCB |
| Generic | SP970 | SP970 | Another common board variant |

Key references:
- [asvdvl/uz801-v3.0_stuff](https://github.com/asvdvl/uz801-v3.0_stuff) -- community docs for v3.0
- [4pda.to MSM8916 stick thread](https://4pda.to/forum/index.php?showtopic=1030895) -- Russian forum, active community

## Thermal Issue (Critical)

### Problem

The MSM8916 SoC hits hardware thermal protection (~97C die temperature) every
30-60 seconds under normal operation. The device reboots without warning.
This is not a software bug -- it is a hardware design flaw.

**Root cause (v3.0 board):** The main SoC, eMCP memory, and LTE RF amplifier
are all located under a single RF shield with **no thermal pads** connecting
the chips to the shield. Heat has no path to dissipate.

The manufacturer's own mitigation was to disable 2 of 4 CPU cores in firmware.
This is insufficient -- the device still overheats at stock frequencies.

### Measured thermal data

Tested on TianJie U800-3 (UZ801 v3.0), 2026-03-05.

**Available thermal sensors (via ADB):**
| Sensor | Reading | Notes |
|--------|---------|-------|
| pm8916_tz (PMIC) | 50-55C | Only reliable sensor |
| tsens_tz_sensor0-4 | 0.1C | Broken on stock firmware |
| bms/battery | 22.5C | Ambient temperature, useless |

**CPU frequency vs survival time:**

| Frequency | Governor | Cores | Survival | PMIC temp trend |
|-----------|----------|-------|----------|-----------------|
| 1190 MHz (stock) | ondemand | 2 | ~30s | Rising, 55C+ at reboot |
| 800 MHz | userspace | 1 | ~25s | Rising |
| 400 MHz | userspace | 1 | ~51s | Cooling slowly |
| 200 MHz | userspace | 1 | ~65s | Cooling to 52C, still reboots |

Even at 200 MHz with a single core, the device eventually reboots.
The PMIC was actively cooling (55C -> 52C), but the SoC die temperature
(invisible to software) still hits the hardware trip point. The thermal
path between SoC die and PMIC is poor -- PMIC temperature lags by 10-15C.

### Software mitigations (partial, not sufficient alone)

These extend survival time but do not solve the root cause:

1. **Kill mpdecision daemon** -- prevents automatic CPU frequency scaling
   ```
   adb shell stop mpdecision
   adb shell killall mpdecision
   ```

2. **Set userspace governor + lock frequency**
   ```
   adb shell 'echo userspace > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'
   adb shell 'echo 200000 > /sys/devices/system/cpu/cpu0/cpufreq/scaling_setspeed'
   ```

3. **Offline extra cores**
   ```
   adb shell 'echo 0 > /sys/devices/system/cpu/cpu1/online'
   ```

4. **Disable WiFi** (reduces RF amplifier heat)
   ```
   # Via HTTP API: funcNo=1019
   # Note: WiFi was already OFF on our test unit -- not the primary heat source
   ```

5. **Enable ADB** (needed for CPU controls)
   ```
   # Via HTTP API: POST /ajax with funcNo=2001
   # Device reboots to PID 0x9024 (RNDIS + ADB), persists across reboots
   ```

### Hardware solutions (recommended)

These address the root cause and enable stable sustained operation:

1. **Thermal pads (0.5mm)** between SoC/eMCP and RF shield.
   The community reports stable operation after adding thermal interface
   material. The RF shield acts as a heatsink once thermally connected.

2. **External heatsink** on the RF shield (after thermal pad mod).
   Further improves dissipation for heavy workloads.

3. **USB extension cable** -- moves the stick away from the host USB port,
   which can add heat from adjacent components.

4. **Active cooling** -- small fan or open-air mounting. Extreme but effective
   for always-on deployments.

### Community consensus

From 4pda.to, GitHub issues, and OpenWrt forums:
- No software-only fix exists for sustained operation
- Thermal pads are the standard community fix
- Some users report the v3.2 board has slightly better thermal design
- The v2.0 board reportedly had thermal pads from factory (unconfirmed)

## USB Compositions

### Default (PID 0xF00E)

Single RNDIS interface. No serial ports, no ADB.
Management exclusively via HTTP API over RNDIS.

### ADB enabled (PID 0x9024)

RNDIS + ADB. Enabled via funcNo=2001 HTTP API call.
Gives root shell access to the Android system.
Persists across reboots (stored in firmware config).

### Serial + Diag + ADB (PID 0x90B6)

Observed after thermal boot-loop recovery. Composition:

| Interface | Class | Function | Endpoints |
|-----------|-------|----------|-----------|
| 0 | 224/1/3 | RNDIS control | Interrupt only |
| 1 | 10/0/0 | RNDIS data | Non-functional on macOS |
| 2 | 255/0/0 | AT modem | Bulk 0x83 IN, 0x02 OUT + Int 0x84 |
| 3 | 255/255/255 | DIAG | Bulk 0x85 IN, 0x03 OUT |
| 4 | 255/66/1 | ADB | Bulk 0x86 IN, 0x04 OUT |

ADB requires `0x05c6` in `~/.android/adb_usb.ini` (for the external `adb` binary).

**cellary ADB-over-USB (`connectAdbOverUsb`):** speaks the ADB wire protocol
directly over interface 4's bulk endpoints (0x86 IN / 0x04 OUT) -- no `adb`
binary, no network. This adbd is Android 4.4 (KitKat) and needs a strict V1
handshake, or it goes "offline" and never replies with its own CNXN:

- **Max payload 4096** (CNXN arg1). Version 0x01000000 is ADB V1, which mandates
  a 4096 cap; advertising 256KB makes old adbd drop the handshake.
- **Plain `host::` banner** -- the `features=shell_v2` banner (2016+) is rejected.
- **Header and payload as separate bulk transfers** -- FunctionFS adbd reads the
  24-byte header and the payload with distinct reads; a single combined transfer
  strands the payload.
- A wedged adbd (from a bad prior handshake) only recovers via a USB port reset
  (libusb `device.reset()`) or a physical replug.

### AT serial quirks (PID 0x90B6)

**CDC ACM DTR requirement (critical):** Qualcomm serial_smd (interface 2)
silently drops ALL data unless SET_CONTROL_LINE_STATE (DTR+RTS) is sent first.
SET_LINE_CODING (115200 8N1) also accepted. UsbTransport uses `assertDtr: true`.

**Single-session initialization:** AT channel must init in a single USB session.
Opening a fresh USB connection after closing the previous one causes most commands
to return ERROR (sim_state=255). Must do CFUN=1 + CMEE=2 + 10s registration wait
in the same session.

**AT+USB? is DANGEROUS:** causes persistent USB composition reset. Recovery
requires physical replug.

### AT modem capabilities (PID 0x90B6, 57/101 commands OK)

Identity: ATI OK (model 4094, FW V3.0_21). AT+CGMI/CGMM/CGMR timeout (use ATI).
SIM: IMSI, ICCID, USIM, READY. Signal: CSQ, $QCSQ (richer). $QCRSRP/$QCRSRQ ERROR.
Network: CREG/CGREG/CEREG roaming. COPS with AcT=7 (LTE). $QCSYSMODE=LTE.
Data: PDP context active, IP assigned. SMS: PDU mode, ME 0/23, SIM 15/15.
Config: 115200 baud, IRA charset, HW flow. USSD supported.

## HTTP API

See the parent directory's `api-types.ts` and `README.md` for full API documentation.

Key endpoints for thermal management:
- funcNo=2001: Enable ADB (device reboots)
- funcNo=1030: Battery status (returns empty on this firmware)
- funcNo=1019: WiFi control (on/off)
- funcNo=1029: Device info (manufacturer, firmware, IMEI, signal)

## Device profile (measured)

Pulled from a live UZ801 (board `ALK`) over ADB. Values vary slightly by seller
firmware, but the SoC/Android/kernel generation is consistent across these sticks.

| Property | Value |
|----------|-------|
| Android | 4.4.4 (KitKat), SDK 19, codename REL |
| Kernel | Linux 3.10.28 SMP PREEMPT, gcc 4.7 |
| SoC / board | msm8916 / ALK |
| Device / model | msm8916_32_512 / UZ801 |
| Build fingerprint | `qcom/msm8916_32_512:4.4.4/KTU84P/eng..20220822:userdebug/test-keys` |
| Build date | 2022-08-22 |
| CPU ABI | armeabi-v7a (+ armeabi) |
| Manufacturer | Qualcomm Technology |
| Locale | zh-CN |
| adbd | insecure (no RSA auth), root shell (uid=0) |
| `persist.adb.tcp.port` | 7628 |
| `persist.sys.usb.config` | `rndis,serial_smd,diag,adb` (PID 0x90B6) |

`userdebug` + `test-keys` + root adbd is why sysfs thermal control (read
`pm8916_tz`/`tsens`, write `scaling_max_freq`, `stop mpdecision`) is possible
without unlocking. Note: on board `ALK` the `tsens` die sensors report real
values (54-58C); the "tsens broken, only pm8916_tz reliable" note in `index.ts`
was measured on a TianJie U800-3 v3.0 board and is not universal.

## Firmware

The stock firmware varies by seller but is generally the same Android build.
Community firmware projects exist:
- [OpenStick](https://github.com/OpenStick) -- Debian/PostmarketOS for MSM8916 sticks
- Custom Android ROMs with fixed thermal management

Flashing requires EDL mode (hold button during boot) or ADB sideload.
Bricked devices (PID 0x9008) can be recovered with Qualcomm QFIL tool.
