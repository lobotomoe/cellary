/** Alcatel (TCL / T&A Mobile Phones) USB vendor ID */
export const ALCATEL_VID = 0x1bbb

/**
 * Alcatel "Mobilebroadband" USB product ID.
 *
 * PID 0x0908 is the modem mode (bDeviceClass=2, Communications).
 * Not in usb_modeswitch database — device appears directly in modem mode.
 *
 * Interfaces (hardware-verified):
 * - IF0: CDC-ECM control (class 2/6) — Ethernet over USB
 * - IF1: CDC Data (class 10/0) — ECM data pair
 * - IF2: Mass Storage (class 8/6) — virtual CD-ROM
 *
 * No ACM serial ports. No web interface. Data-only via CDC-ECM.
 * Gateway 192.168.8.1 does not respond (ARP incomplete).
 */
export const MOBILEBROADBAND_PID = 0x0908
