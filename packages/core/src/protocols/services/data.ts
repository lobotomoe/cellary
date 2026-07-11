// ─── Data Connection Domain Types ────────────────────────────────────────────

export type DataConnectionState = 'connected' | 'disconnected' | 'connecting' | 'disconnecting'

export interface DataConnectionStatus {
  readonly state: DataConnectionState
  /** Whether PS (Packet-Switched) domain is attached. */
  readonly attached: boolean
}

export interface PdpContext {
  readonly cid: number
  /** PDP type: 'IP', 'IPV6', 'IPV4V6', 'PPP' */
  readonly pdpType: string
  /** Access Point Name. Undefined when not available (e.g. auto-managed by firmware). */
  readonly apn: string | undefined
  readonly active: boolean
  readonly address?: string | undefined
}

/**
 * PDP context dynamic parameters from the network.
 *
 * Shows the actual parameters in effect for an active PDP context
 * (IP address, DNS, gateway assigned by network).
 */
export interface PdpDynamicParams {
  readonly cid: number
  /** Bearer ID assigned by the network */
  readonly bearerId?: number | undefined
  /** APN in use (may differ from requested if network redirects) */
  readonly apn?: string | undefined
  /** Local IP address (may include subnet mask for IPv4: "a.b.c.d.m.m.m.m") */
  readonly localAddress?: string | undefined
  /** Default gateway address */
  readonly gatewayAddress?: string | undefined
  /** Primary DNS server address */
  readonly primaryDns?: string | undefined
  /** Secondary DNS server address */
  readonly secondaryDns?: string | undefined
}

/** PDP context authentication type. */
export type PdpAuthType =
  | 'none' // no authentication
  | 'pap' // PAP (Password Authentication Protocol)
  | 'chap' // CHAP (Challenge Handshake Authentication Protocol)

/**
 * EPS Quality of Service parameters for a PDP context.
 *
 * QCI (QoS Class Identifier) determines the treatment of IP packets.
 * GBR/MBR values are in kbps.
 */
export interface EpsQosParams {
  readonly cid: number
  /** QoS Class Identifier (1-9 standard, 65-79 extended). 0 = not specified. */
  readonly qci: number
  /** Downlink Guaranteed Bit Rate in kbps */
  readonly dlGbr?: number | undefined
  /** Uplink Guaranteed Bit Rate in kbps */
  readonly ulGbr?: number | undefined
  /** Downlink Maximum Bit Rate in kbps */
  readonly dlMbr?: number | undefined
  /** Uplink Maximum Bit Rate in kbps */
  readonly ulMbr?: number | undefined
}

/**
 * UE mode of operation for EPS.
 *
 * Determines how the modem balances voice (CS) and data (PS) services.
 */
export type UeOperationMode =
  | 'psMode2' // data only, no CS fallback
  | 'csPsMode1' // voice and data (default)
  | 'csPsMode2' // voice and data, PS preferred
  | 'psMode1' // data only, with IMS voice

// ─── Data Service Interface ──────────────────────────────────────────────────

export interface Data {
  status(): Promise<DataConnectionStatus>
  contexts(): Promise<PdpContext[]>
  defineContext?(cid: number, pdpType: string, apn: string): Promise<void>
  activate?(cid: number): Promise<void>
  deactivate?(cid: number): Promise<void>

  /**
   * Read dynamic parameters for active PDP context(s).
   *
   * Returns network-assigned parameters: IP address, DNS, gateway.
   * If cid is omitted, returns params for all active contexts.
   */
  dynamicParameters?(cid?: number): Promise<PdpDynamicParams[]>

  /**
   * Set PDP context authentication parameters.
   *
   * @param cid - Context ID
   * @param authType - Authentication protocol ('none', 'pap', 'chap')
   * @param username - Username for PAP/CHAP
   * @param password - Password for PAP/CHAP
   */
  setAuthentication?(
    cid: number,
    authType: PdpAuthType,
    username?: string,
    password?: string,
  ): Promise<void>

  /** Re-negotiate QoS parameters for an active PDP context. */
  modify?(cid: number): Promise<void>

  // -- EPS QoS --

  /**
   * Read EPS QoS parameters for a PDP context.
   *
   * Returns the configured QCI and optional GBR/MBR values (in kbps).
   * If cid is omitted, returns params for all defined contexts.
   */
  epsQos?(cid?: number): Promise<EpsQosParams[]>

  /**
   * Read negotiated EPS QoS parameters from the network.
   *
   * Returns the actual QoS in effect, which may differ from what was requested.
   * If cid is omitted, returns params for all active contexts.
   */
  negotiatedEpsQos?(cid?: number): Promise<EpsQosParams[]>

  /**
   * Define EPS QoS parameters for a PDP context.
   *
   * @param params - QoS parameters including cid, qci, and optional GBR/MBR values in kbps
   */
  setEpsQos?(params: EpsQosParams): Promise<void>

  // -- UE mode of operation --

  /** Query the current UE mode of operation for EPS. */
  ueMode?(): Promise<UeOperationMode>

  /**
   * Set the UE mode of operation for EPS.
   *
   * Controls how the modem balances voice (CS) and data (PS) services.
   */
  setUeMode?(mode: UeOperationMode): Promise<void>
}
