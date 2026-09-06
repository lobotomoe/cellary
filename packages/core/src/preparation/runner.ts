/**
 * Preparation pipeline runner.
 *
 * Executes a PrepProfile against a live modem: read-only health checks first,
 * then (per policy) executable remediations. Produces a PrepReport with the
 * verdict, step results, remediation results, limitations, and recommendations.
 */

import type { Logger } from '../logger.js'
import { applyRemediations, type RemediationPolicy } from './remediation-runner.js'
import type {
  HealthCheck,
  Limitation,
  PreparationTarget,
  PrepProfile,
  PrepReport,
  RemediationRecord,
  StepOutcome,
  StepRecord,
} from './types.js'

interface DeviceInfo {
  readonly name: string
  readonly vendorId: number
  readonly productId: number
}

/**
 * Run a profile's health checks against a live modem (read-only).
 *
 * Does NOT apply remediations — use runPreparation() for the full pipeline.
 * Kept as the diagnostic-only entry point.
 */
export async function runHealthChecks(
  modem: PreparationTarget,
  profile: PrepProfile,
  device: DeviceInfo,
  log: Logger,
): Promise<PrepReport> {
  const startTime = Date.now()
  const records = await runChecks(modem, profile.checks, log)
  return buildReport(device, records, [], profile.limitations, startTime)
}

/**
 * Run the full preparation pipeline: health checks, then remediations.
 *
 * Remediations are detected and, when the policy allows their recoverability
 * level, applied and verified. The default policy applies only
 * software-reversible fixes (see remediation-runner).
 */
export async function runPreparation(
  modem: PreparationTarget,
  profile: PrepProfile,
  device: DeviceInfo,
  log: Logger,
  policy?: RemediationPolicy,
): Promise<PrepReport> {
  const startTime = Date.now()
  const records = await runChecks(modem, profile.checks, log)
  const remediations = await applyRemediations(modem, profile.remediations ?? [], log, policy)
  return buildReport(device, records, remediations, profile.limitations, startTime)
}

async function runChecks(
  modem: PreparationTarget,
  checks: readonly HealthCheck[],
  log: Logger,
): Promise<StepRecord[]> {
  const records: StepRecord[] = []

  for (const check of checks) {
    const stepStart = Date.now()
    let outcome: StepOutcome

    try {
      outcome = await check.execute(modem, log)
    } catch (err: unknown) {
      // Steps should NOT throw, but capture as failed if they do
      const message = err instanceof Error ? err.message : String(err)
      outcome = { status: 'failed', error: message, recoverable: false }
    }

    const durationMs = Date.now() - stepStart
    records.push({ id: check.id, name: check.name, kind: check.kind, outcome, durationMs })
    log.debug('Health check completed', { id: check.id, status: outcome.status, durationMs })
  }

  return records
}

function buildReport(
  device: DeviceInfo,
  records: readonly StepRecord[],
  remediations: readonly RemediationRecord[],
  limitations: readonly Limitation[],
  startTime: number,
): PrepReport {
  return {
    device,
    verdict: deriveVerdict(records, remediations, limitations),
    steps: records,
    limitations,
    remediations,
    recommendations: collectRecommendations(records, remediations, limitations),
    durationMs: Date.now() - startTime,
  }
}

/**
 * Derive the overall verdict from checks, remediations, and limitations.
 *
 * - Any non-recoverable check failure -> 'failed'
 * - Any degraded check, recoverable check failure, failed remediation, or
 *   applied-but-unverified remediation -> 'degraded'
 * - Any critical limitation -> 'degraded' (the hardware fact stands even when a
 *   remediation mitigates it — e.g. a volatile thermal cap)
 * - Otherwise -> 'ready'
 */
function deriveVerdict(
  records: readonly StepRecord[],
  remediations: readonly RemediationRecord[],
  limitations: readonly Limitation[],
): 'ready' | 'degraded' | 'failed' {
  let hasDegraded = false

  for (const record of records) {
    if (record.outcome.status === 'failed') {
      if (!record.outcome.recoverable) return 'failed'
      hasDegraded = true
    }
    if (record.outcome.status === 'degraded') {
      hasDegraded = true
    }
  }

  for (const rem of remediations) {
    if (rem.outcome.status === 'failed') hasDegraded = true
    if (rem.outcome.status === 'applied' && !rem.outcome.verified) hasDegraded = true
  }

  const hasCriticalLimitation = limitations.some((l) => l.severity === 'critical')
  if (hasCriticalLimitation || hasDegraded) return 'degraded'

  return 'ready'
}

/**
 * Generate recommendations from check outcomes, remediation outcomes, and
 * limitations. A limitation's raw workaround text is suppressed once a
 * remediation has successfully handled its scope — no point telling the user to
 * do by hand what the pipeline already did.
 */
function collectRecommendations(
  records: readonly StepRecord[],
  remediations: readonly RemediationRecord[],
  limitations: readonly Limitation[],
): string[] {
  const recommendations: string[] = []

  for (const record of records) {
    const { outcome } = record

    if (outcome.status === 'failed') {
      if (outcome.error.includes('PIN required')) {
        recommendations.push('Enter SIM PIN using modem.sim.enterPin() or `cellary sim pin <code>`')
      } else if (outcome.error.includes('PUK required')) {
        recommendations.push('SIM is PUK-locked. Contact your carrier to obtain the PUK code')
      } else if (outcome.error.includes('Not registered')) {
        recommendations.push(
          'Device is not registered. Check antenna connection and signal coverage',
        )
      }
    }

    if (outcome.status === 'degraded') {
      if (outcome.detail.includes('Searching')) {
        recommendations.push('Network search in progress. Wait 30-60 seconds and check again')
      } else if (outcome.detail.includes('No SIM')) {
        recommendations.push('Insert a SIM card and reconnect the device')
      } else if (outcome.detail.includes('denied')) {
        recommendations.push('Network registration denied. Check SIM validity and roaming settings')
      }
    }
  }

  const handledScopes = new Set<string>()
  for (const rem of remediations) {
    const { outcome } = rem
    if (outcome.status === 'applied') {
      const suffix = outcome.verified ? '' : ' (unverified)'
      recommendations.push(`${rem.scope}: applied ${rem.id}${suffix}`)
      if (outcome.verified) handledScopes.add(rem.scope)
    } else if (outcome.status === 'not-needed') {
      // Fix already in place (or not applicable) — suppress the manual
      // workaround so we don't tell the user to do what's already done.
      handledScopes.add(rem.scope)
    } else if (outcome.status === 'skipped') {
      recommendations.push(`${rem.scope}: ${rem.id} available — ${outcome.reason}`)
    } else if (outcome.status === 'failed') {
      recommendations.push(`${rem.scope}: ${rem.id} failed — ${outcome.error}`)
    }
  }

  for (const limitation of limitations) {
    if (limitation.workaround !== undefined && !handledScopes.has(limitation.scope)) {
      recommendations.push(`${limitation.scope}: ${limitation.workaround}`)
    }
  }

  return recommendations
}
