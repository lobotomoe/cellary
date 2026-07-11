/**
 * Device Preparation Protocol types.
 *
 * Defines the extensible standard for preparing a device for operation.
 * Each model declares a PrepProfile (checks + limitations). The pipeline
 * runner executes the profile and produces a PrepReport.
 *
 * Adding a new device = declare a PrepProfile. No custom preparation code.
 */

import type { Logger } from '../logger.js'

// ── Step outcome ────────────────────────────────────────────────────────────

/**
 * What kind of work a preparation step does.
 *
 * Each kind has clear semantic guarantees:
 *
 * - `diagnostic` — read-only observation of device state.
 *   Idempotent, no side effects, safe to run at any time.
 *   Examples: SIM status, network registration, thermal reading.
 *
 * - `action` — state-mutating operation on the device.
 *   May have side effects, ordering matters, may not be idempotent.
 *   Examples: mode switch, PIN entry, CPU frequency cap.
 *
 * - `verification` — read-only confirmation that a preceding action
 *   achieved its goal. Semantically tied to an action.
 *   Examples: re-check registration after mode switch,
 *   re-read temperature after thermal mitigation.
 */
export type StepKind = 'diagnostic' | 'action' | 'verification'

/**
 * Outcome of a single preparation step.
 *
 * Steps MUST return one of these — they must NOT throw.
 * The runner wraps unexpected throws as a safety net.
 */
export type StepOutcome =
  | { readonly status: 'passed'; readonly detail?: string | undefined }
  | { readonly status: 'fixed'; readonly detail: string }
  | { readonly status: 'degraded'; readonly detail: string }
  | { readonly status: 'failed'; readonly error: string; readonly recoverable: boolean }
  | { readonly status: 'skipped'; readonly reason: string }

// ── Health check ────────────────────────────────────────────────────────────

/**
 * A health check that runs against a live modem.
 *
 * Health checks verify device state AFTER the modem is opened and initialized.
 * They receive the full Modem instance with all adapters ready.
 *
 * To add a new check: implement this interface and add it to a PrepProfile.
 */
export interface HealthCheck {
  /** Unique identifier, e.g. 'sim', 'registration', 'thermal' */
  readonly id: string
  /** Human-readable name for display */
  readonly name: string
  /** Semantic kind: diagnostic (read-only), action (mutating), or verification (post-action) */
  readonly kind: StepKind
  /**
   * Execute the check against a live modem.
   *
   * The modem parameter is typed as `unknown` to avoid a circular dependency
   * between preparation/types.ts and modem.ts. Implementations cast it to
   * the Modem type they need. This is the one place where the tradeoff of
   * a loose type is worth the decoupling benefit.
   */
  execute(modem: unknown, log: Logger): Promise<StepOutcome>
}

// ── Limitation ──────────────────────────────────────────────────────────────

/**
 * A known device limitation.
 *
 * Limitations are facts, not suggestions. They describe permanent
 * or firmware-level restrictions that exist regardless of preparation
 * outcome. Declared statically per model.
 */
export interface Limitation {
  /** Which service or feature is limited, e.g. 'thermal', 'stk', 'voice' */
  readonly scope: string
  /** How bad it is */
  readonly severity: 'info' | 'warning' | 'critical'
  /** What the limitation is */
  readonly description: string
  /** What the user can do about it (if anything) */
  readonly workaround?: string | undefined
}

// ── Remediation ───────────────────────────────────────────────────────────

/**
 * How recoverable a remediation is. Governs auto-apply policy, ordered from
 * safest to riskiest (see architecture: software-first, recoverable operations).
 *
 * - `software-reversible`  — AT command / sysfs write, undone by a reboot.
 *   Safe to auto-apply.
 * - `software-persistent`  — NVM / filesystem write that survives reboot.
 *   Applied only with explicit opt-in.
 * - `hardware-automatable` — USB re-enumeration, reboot. Automatable but
 *   disruptive; applied only with explicit opt-in.
 * - `manual-hardware`      — physical intervention (replug, thermal pad).
 *   Never auto-applied; reported only.
 */
export type Recoverability =
  | 'software-reversible'
  | 'software-persistent'
  | 'hardware-automatable'
  | 'manual-hardware'

/** Context handed to every remediation step. */
export interface RemediationContext {
  /**
   * The live modem. Typed `unknown` to avoid a circular dependency between
   * preparation/types.ts and modem.ts — the same tradeoff as HealthCheck.execute.
   * Implementations narrow it to the Modem shape they need.
   */
  readonly modem: unknown
  readonly log: Logger
}

/** Outcome of attempting a single remediation. */
export type RemediationOutcome =
  | { readonly status: 'not-needed' }
  | { readonly status: 'applied'; readonly verified: boolean; readonly detail?: string | undefined }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string }

/**
 * An executable fix for a known device limitation.
 *
 * Where a Limitation only *describes* a problem, a Remediation can *detect*
 * whether it currently applies, *apply* the fix, and *verify* it took hold.
 * Remediations are the actionable counterpart to Limitation.workaround — the
 * first extensibility point for the preparation pipeline: adding a new fix is
 * just declaring another Remediation on a model's PrepProfile.
 */
export interface Remediation {
  /** Unique identifier, e.g. 'thermal-cap'. */
  readonly id: string
  /** Which limitation scope this addresses (matches Limitation.scope). */
  readonly scope: string
  /** Human-readable description of what the fix does. */
  readonly description: string
  /** How recoverable the fix is — governs whether it auto-applies. */
  readonly recoverability: Recoverability
  /** Detect whether the fix is currently needed. Read-only. */
  isNeeded(ctx: RemediationContext): Promise<boolean>
  /** Apply the fix. Mutating. */
  apply(ctx: RemediationContext): Promise<void>
  /** Confirm the fix took effect. Read-only. */
  verify(ctx: RemediationContext): Promise<boolean>
}

/** Recorded remediation attempt in the preparation report. */
export interface RemediationRecord {
  readonly id: string
  readonly scope: string
  readonly recoverability: Recoverability
  readonly outcome: RemediationOutcome
  readonly durationMs: number
}

// ── Profile ─────────────────────────────────────────────────────────────────

/**
 * Per-model preparation profile.
 *
 * Declares which health checks to run and what limitations to report.
 * Each model exports its own profile. The generic profile covers
 * standard 3GPP AT modems with no special needs.
 */
export interface PrepProfile {
  /** Human-readable name, e.g. 'Huawei E8372 HiLink+AT' */
  readonly name: string
  /** Health checks to run after the modem is opened */
  readonly checks: readonly HealthCheck[]
  /** Known limitations — always included in the report */
  readonly limitations: readonly Limitation[]
  /**
   * Executable fixes for this device's limitations. Detected (isNeeded) and,
   * when policy permits, applied + verified by the preparation runner.
   * Optional — a device with no remediations behaves exactly as before.
   */
  readonly remediations?: readonly Remediation[]
}

// ── Report ──────────────────────────────────────────────────────────────────

/** Recorded step in the preparation report. */
export interface StepRecord {
  readonly id: string
  readonly name: string
  readonly kind: StepKind
  readonly outcome: StepOutcome
  readonly durationMs: number
}

/**
 * Full preparation report.
 *
 * Machine-readable. Contains every step that was run, its outcome,
 * known limitations, and actionable recommendations.
 *
 * Available on `modem.preparation` after `Modem.detect()`.
 */
export interface PrepReport {
  /** Device identity */
  readonly device: {
    readonly name: string
    readonly vendorId: number
    readonly productId: number
  }
  /** Overall verdict */
  readonly verdict: 'ready' | 'degraded' | 'failed'
  /** Every step that was executed, in order */
  readonly steps: readonly StepRecord[]
  /** Known limitations of this device/model */
  readonly limitations: readonly Limitation[]
  /** Remediations attempted during preparation (empty when the profile declares none) */
  readonly remediations: readonly RemediationRecord[]
  /** Actionable recommendations generated from step outcomes */
  readonly recommendations: readonly string[]
  /** Total preparation time in milliseconds */
  readonly durationMs: number
}
