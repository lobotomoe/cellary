// ─── Capabilities ───────────────────────────────────────────────────────────

/** Full modem capabilities discovered via AT+CLAC and enrichment probes */
export interface ModemCapabilities {
  /** All supported AT commands from AT+CLAC. Empty if CLAC not supported. */
  readonly commands: readonly string[]

  readonly sms: SmsCapabilities
  readonly voice: VoiceCapabilities
  readonly network: NetworkCapabilities
  readonly sim: SimCapabilities
  readonly ussd: UssdCapabilities
  readonly data: DataCapabilities
  readonly stk: StkCapabilities
}

export interface SmsCapabilities {
  readonly send: boolean
  readonly receive: boolean
  readonly read: boolean
  readonly delete: boolean
  readonly multipart: boolean
  /** Supported modes: 'pdu', 'text' */
  readonly modes: readonly string[]
  /** Available storage locations: 'SM', 'ME', etc. */
  readonly storage: readonly string[]
}

export interface VoiceCapabilities {
  readonly dial: boolean
  readonly answer: boolean
  readonly hangup: boolean
  readonly dtmf: boolean
  readonly forwarding: boolean
  readonly waiting: boolean
  readonly hold: boolean
  readonly callerId: boolean
  /** Calling line identification restriction (AT+CLIR) */
  readonly clir: boolean
}

export interface NetworkCapabilities {
  readonly signal: boolean
  readonly registration: boolean
  readonly operatorScan: boolean
  readonly gprs: boolean
  /** LTE/EPS registration (AT+CEREG) */
  readonly eps: boolean
}

export interface SimCapabilities {
  readonly imsi: boolean
  readonly iccid: boolean
  readonly pin: boolean
  /** Remaining PIN/PUK retry counts (AT+CPINR) */
  readonly pinRetries: boolean
  /** Facility lock/unlock/query (AT+CLCK) */
  readonly facilityLock: boolean
  /** Change password for facility (AT+CPWD) */
  readonly changePassword: boolean
  readonly phonebook: boolean
  /** Generic SIM access (AT+CSIM) */
  readonly genericAccess: boolean
  /** Restricted SIM access (AT+CRSM) */
  readonly restrictedAccess: boolean
}

export interface UssdCapabilities {
  readonly supported: boolean
}

export interface DataCapabilities {
  readonly pdpContext: boolean
  /** Supported PDP types: 'IP', 'PPP', 'IPV6', etc. */
  readonly types: readonly string[]
}

export interface StkCapabilities {
  /** Whether the modem supports SIM Toolkit (proactive SIM commands) */
  readonly supported: boolean
}
