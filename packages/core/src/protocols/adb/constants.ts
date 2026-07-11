/**
 * ADB wire protocol constants.
 *
 * Reference: https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/protocol.txt
 */

// ── ADB message commands ────────────────────────────────────────────────────

/** CNXN: connection handshake */
export const A_CNXN = 0x4e584e43
/** OPEN: open a new stream */
export const A_OPEN = 0x4e45504f
/** WRTE: write data to a stream */
export const A_WRTE = 0x45545257
/** OKAY: stream acknowledgment */
export const A_OKAY = 0x59414b4f
/** CLSE: close a stream */
export const A_CLSE = 0x45534c43
/** AUTH: authentication (RSA) */
export const A_AUTH = 0x48545541

// ── Protocol constants ──────────────────────────────────────────────────────

/** ADB protocol version 0x01000000 */
export const ADB_VERSION = 0x0100_0000
/**
 * Maximum payload size per message, advertised in the CNXN handshake.
 *
 * This is tied to the protocol version: version 0x01000000 (V1) mandates a
 * 4096-byte cap. Advertising a larger value with a V1 CNXN makes old adbd
 * (e.g. Android 4.4 on MSM8916/Qualcomm sticks) reject the handshake and
 * go "offline" -- it never replies with its own CNXN. cellary targets these
 * embedded/old-adbd devices, so keep the V1-consistent 4096.
 */
export const ADB_MAX_PAYLOAD = 4096
/** Header size: 6 x uint32 = 24 bytes */
export const ADB_HEADER_SIZE = 24
/** Default ADB TCP port */
export const ADB_DEFAULT_PORT = 5555

// ── Connect / handshake timeout ─────────────────────────────────────────────

/** TCP connect timeout in milliseconds */
export const ADB_CONNECT_TIMEOUT_MS = 5_000
/** Shell command default timeout in milliseconds */
export const ADB_SHELL_TIMEOUT_MS = 30_000
