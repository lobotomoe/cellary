import type { Logger } from './logger.js'

// ── Firmware Info ────────────────────────────────────────────────────────────

/** Firmware version and build metadata read from a device. */
export interface FirmwareInfo {
  /** Firmware version string, e.g. "21.328.62.00.00" */
  readonly version: string
  /** Hardware revision, e.g. "CL2E3372HM Ver.A" */
  readonly hardwareVersion?: string | undefined
  /** Web UI version (devices with HTTP API), e.g. "17.100.20.00.00" */
  readonly webUiVersion?: string | undefined
  /** Firmware build date, e.g. "2019-08-20" */
  readonly buildDate?: string | undefined
  /** Vendor-specific metadata not covered by the standard fields. */
  readonly vendorMeta?: Readonly<Record<string, string>> | undefined
}

// ── Flash Progress ──────────────────────────────────────────────────────────

/** Phases of a firmware flash operation, in order. */
export type FlashPhase =
  | 'validating'
  | 'preparing'
  | 'erasing'
  | 'writing'
  | 'verifying'
  | 'rebooting'

/** Progress event emitted during a flash operation. */
export interface FlashProgress {
  readonly phase: FlashPhase
  readonly message: string
  /** Overall progress percentage (0-100). Not all phases can report this. */
  readonly percent?: number | undefined
}

// ── Flash Result ────────────────────────────────────────────────────────────

/** Outcome of a completed flash operation. */
export interface FlashResult {
  readonly success: boolean
  /** Firmware version after flash (read back from device). */
  readonly newVersion?: string | undefined
  /** Total duration of the flash operation in milliseconds. */
  readonly durationMs: number
  /** Non-fatal warnings encountered during flashing. */
  readonly warnings: readonly string[]
}

// ── Flasher Interface ───────────────────────────────────────────────────────

/**
 * Firmware flasher for a specific vendor's hardware.
 *
 * Flashing is NOT a modem service -- it disconnects the modem, uses a
 * completely different protocol (USB bulk transfer, vendor binary framing),
 * may change the device's USB PID, and requires a reboot afterward.
 *
 * Access via VendorPlugin.createFlasher() rather than ProtocolAdapter.
 */
export interface Flasher {
  /**
   * Read current firmware information from the device.
   * May use AT commands, USB descriptors, or vendor HTTP API depending on
   * the device state.
   */
  firmwareInfo(): Promise<FirmwareInfo>

  /**
   * Validate a firmware image file before flashing.
   *
   * Returns an array of validation warnings (empty = image looks good).
   * Throws if the image is fundamentally incompatible (wrong model,
   * corrupted, unsupported format).
   */
  validate(imagePath: string): Promise<readonly string[]>

  /**
   * Flash the firmware image to the device.
   *
   * This is a destructive, long-running operation. The device will be
   * disconnected and rebooted. The caller must NOT use the Modem instance
   * during or after this call -- it will be invalid.
   *
   * @param imagePath - Path to the firmware image file
   * @param onProgress - Callback for progress updates during flashing
   */
  flash(imagePath: string, onProgress?: (progress: FlashProgress) => void): Promise<FlashResult>
}

/** Options for creating a Flasher instance. */
export interface FlasherOptions {
  readonly vendorId: number
  readonly productId: number
  readonly logger?: Logger | undefined
}
