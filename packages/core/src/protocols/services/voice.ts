// ─── Voice / Call Domain Types ───────────────────────────────────────────────

/**
 * CLIR (Calling Line Identification Restriction) setting.
 *
 * Controls whether the caller's number is shown to the called party.
 */
export type ClirSetting =
  | 'subscription' // per subscription default
  | 'invocation' // restrict (hide number)
  | 'suppression' // allow (show number)

/**
 * CLIR network status (provisioning state).
 */
export type ClirStatus =
  | 'notProvisioned' // CLIR not provisioned
  | 'permanent' // CLIR permanently provisioned
  | 'unknown' // unknown (e.g. no network)
  | 'temporaryRestricted' // temporary mode, restriction default
  | 'temporaryAllowed' // temporary mode, allow default

/**
 * Phone number format classification.
 *
 * - `international`: includes country code prefix (e.g. "+37494123456")
 * - `national`: local format without country code (e.g. "094123456")
 */
export type NumberFormat = 'international' | 'national'

/** Call forwarding rule. */
export interface CallForwardingRule {
  readonly active: boolean
  /** Service class (1=voice, 2=data, 4=fax, etc.) */
  readonly serviceClass: number
  /** Forwarding number. Undefined when not set. */
  readonly number?: string | undefined
  /** Number format. Undefined when no number. */
  readonly numberFormat?: NumberFormat | undefined
  /**
   * No-reply timeout in seconds (5-30, step 5).
   * Only meaningful for 'noReply' reason.
   */
  readonly time?: number | undefined
}

/** Why calls should be forwarded. */
export type CallForwardReason =
  | 'unconditional' // forward all calls
  | 'busy' // forward when busy
  | 'noReply' // forward when no answer
  | 'notReachable' // forward when unreachable
  | 'all' // all forwarding reasons
  | 'allConditional' // all conditional reasons (busy + noReply + notReachable)

/** What operation to perform on a forwarding rule. */
export type CallForwardMode =
  | 'disable' // deactivate forwarding
  | 'enable' // activate forwarding
  | 'register' // set forwarding number
  | 'erase' // delete forwarding rule

/**
 * Complete call lifecycle state, unified across all protocols.
 *
 * Every call transition produces exactly one CallEvent with a CallState.
 * Not all modems emit every intermediate state -- a basic modem may only
 * produce 'incoming' and 'ended'. Vendor plugins add granularity.
 *
 *   Outgoing: dialing -> setup -> alerting -> active -> ended
 *   Incoming: incoming -> active -> ended
 */
export type CallState =
  | 'incoming' // MT call arriving
  | 'waiting' // second MT call while first is active (call waiting)
  | 'dialing' // MO call initiated, not yet at network
  | 'setup' // MO call at network level
  | 'alerting' // remote phone ringing
  | 'active' // voice path established
  | 'held' // call on hold
  | 'ended' // call terminated

/** Why a call ended. Only meaningful when CallEvent.state === 'ended'. */
export type CallEndReason =
  | 'hangup' // normal termination (remote or local hangup)
  | 'busy' // remote party busy
  | 'noAnswer' // no answer from remote party
  | 'noDialtone' // no dial tone available
  | 'rejected' // call rejected by network or remote
  | 'unknown' // ended but reason not determined

export interface CallEvent {
  readonly state: CallState
  readonly direction: 'incoming' | 'outgoing'
  readonly number?: string | undefined
  /** Caller name from CNAP (Calling Name Presentation), if the network provides it. */
  readonly callerName?: string | undefined
  /** Why the call ended. Only present when state === 'ended'. */
  readonly reason?: CallEndReason | undefined
}

/**
 * MO (mobile-originated) supplementary service notification.
 *
 * Reported during outgoing call setup to indicate SS actions.
 */
export type MoSsNotification =
  | 'forwardingActive' // unconditional forwarding is active
  | 'conditionalForwardingActive' // some conditional forwarding is active
  | 'callForwarded' // call has been forwarded
  | 'callIsWaiting' // call is waiting
  | 'outgoingBarred' // outgoing calls are barred
  | 'incomingBarred' // incoming calls are barred
  | 'clirRejected' // CLIR suppression rejected by network
  | 'callDeflected' // call has been deflected

/**
 * MT (mobile-terminated) supplementary service notification.
 *
 * Reported during incoming call handling to indicate SS actions.
 */
export type MtSsNotification =
  | 'forwardedCall' // this is a forwarded call
  | 'callHeldByRemote' // call has been put on hold by remote
  | 'callRetrievedByRemote' // call has been retrieved by remote
  | 'multipartyEntered' // multiparty call entered
  | 'heldCallReleased' // held call has been released
  | 'callConnecting' // call is being connected (ECT)
  | 'callConnected' // call has been connected (ECT)
  | 'deflectedCall' // this is a deflected call
  | 'additionalForwarded' // additional incoming call forwarded

/** Supplementary service notification event during a voice call. */
export interface SsNotificationEvent {
  readonly direction: 'outgoing' | 'incoming'
  readonly notification: MoSsNotification | MtSsNotification
  /** Phone number associated with the notification, if available. */
  readonly number?: string | undefined
  /** Call index (1-based) for MT notifications, if available. */
  readonly callIndex?: number | undefined
}

/** Active call descriptor returned by {@link Voice.listCalls}. */
export interface ActiveCall {
  /** Call index (1-based) */
  readonly index: number
  readonly direction: 'outgoing' | 'incoming'
  readonly state: CallState
  /** 0 = voice, 1 = data, 2 = fax */
  readonly mode: number
  readonly number?: string | undefined
}

/** Call waiting status for a specific service class. */
export interface CallWaitingStatus {
  /** Whether call waiting is active for this class */
  readonly active: boolean
  /** Service class (1=voice, 2=data, 4=fax, etc.) */
  readonly serviceClass: number
}

export interface Voice {
  dial(number: string): Promise<void>
  answer(): Promise<void>
  hangup(): Promise<void>
  dtmf(tones: string): Promise<void>
  /** List all active calls. Empty array means no calls in progress. */
  listCalls(): Promise<readonly ActiveCall[]>

  // -- Call supplementary services --

  /** Query CLIR setting and network provisioning status. */
  queryClir?(): Promise<{ readonly setting: ClirSetting; readonly status: ClirStatus }>
  /**
   * Set CLIR mode for outgoing calls.
   *
   * @param setting - 'subscription' (network default), 'invocation' (hide), 'suppression' (show)
   */
  setClir?(setting: ClirSetting): Promise<void>

  /**
   * Query call forwarding rules for a specific reason.
   *
   * Returns one entry per active service class.
   */
  queryCallForwarding?(
    reason: CallForwardReason,
    serviceClass?: number,
  ): Promise<CallForwardingRule[]>
  /**
   * Set, enable, disable, or erase a call forwarding rule.
   *
   * @param reason - Forwarding condition ('unconditional', 'busy', 'noReply', 'notReachable')
   * @param mode - Operation ('disable', 'enable', 'register', 'erase')
   */
  setCallForwarding?(
    reason: CallForwardReason,
    mode: CallForwardMode,
    options?: {
      readonly number?: string
      readonly serviceClass?: number
      readonly time?: number
    },
  ): Promise<void>

  /**
   * Query call waiting status per service class.
   *
   * Returns one entry per service class that supports call waiting.
   */
  queryCallWaiting?(serviceClass?: number): Promise<CallWaitingStatus[]>
  /** Enable or disable call waiting. */
  setCallWaiting?(enable: boolean, serviceClass?: number): Promise<void>

  /** Place active calls on hold and accept waiting/held call. */
  holdAndAccept?(): Promise<void>
  /** Add held call to active call for multiparty conference. */
  conference?(): Promise<void>
  /** Release all held calls, or reject a waiting call. */
  releaseHeld?(): Promise<void>
}
