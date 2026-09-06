/**
 * Remediation execution.
 *
 * Where the health-check runner only observes, this applies fixes. Each
 * remediation is detected (isNeeded), and — when the policy permits its
 * recoverability level — applied and verified. Nothing throws out of here:
 * every remediation resolves to a RemediationRecord the report can carry.
 *
 * Policy is software-first: by default only reversible fixes auto-apply.
 * Persistent, hardware, and manual fixes are detected and reported but never
 * applied without an explicit opt-in.
 */

import type { Logger } from '../logger.js'
import type {
  PreparationTarget,
  Recoverability,
  Remediation,
  RemediationContext,
  RemediationOutcome,
  RemediationRecord,
} from './types.js'

/** Which recoverability levels a runner may apply automatically. */
export interface RemediationPolicy {
  readonly autoApply: readonly Recoverability[]
}

/**
 * Default policy: apply only software-reversible fixes (undone by a reboot).
 * Everything riskier is detected and reported, not applied.
 */
export const DEFAULT_REMEDIATION_POLICY: RemediationPolicy = {
  autoApply: ['software-reversible'],
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runOne(
  remediation: Remediation,
  ctx: RemediationContext,
  policy: RemediationPolicy,
): Promise<RemediationOutcome> {
  let needed: boolean
  try {
    needed = await remediation.isNeeded(ctx)
  } catch (err: unknown) {
    return { status: 'failed', error: `isNeeded failed: ${errorMessage(err)}` }
  }

  if (!needed) return { status: 'not-needed' }

  if (!policy.autoApply.includes(remediation.recoverability)) {
    return {
      status: 'skipped',
      reason: `${remediation.recoverability} remediation requires explicit opt-in`,
    }
  }

  try {
    ctx.log.info('Applying remediation', {
      id: remediation.id,
      scope: remediation.scope,
      recoverability: remediation.recoverability,
    })
    await remediation.apply(ctx)
  } catch (err: unknown) {
    return { status: 'failed', error: `apply failed: ${errorMessage(err)}` }
  }

  try {
    const verified = await remediation.verify(ctx)
    return { status: 'applied', verified }
  } catch (err: unknown) {
    return { status: 'applied', verified: false, detail: `verify failed: ${errorMessage(err)}` }
  }
}

/**
 * Detect and (per policy) apply each remediation against a live modem.
 *
 * Runs sequentially — remediations may depend on device state that a prior one
 * changed, and applying them concurrently to one device is unsafe.
 */
export async function applyRemediations(
  modem: PreparationTarget,
  remediations: readonly Remediation[],
  log: Logger,
  policy: RemediationPolicy = DEFAULT_REMEDIATION_POLICY,
): Promise<RemediationRecord[]> {
  const ctx: RemediationContext = { modem, log }
  const records: RemediationRecord[] = []

  for (const remediation of remediations) {
    const start = Date.now()
    const outcome = await runOne(remediation, ctx, policy)
    const durationMs = Date.now() - start

    records.push({
      id: remediation.id,
      scope: remediation.scope,
      recoverability: remediation.recoverability,
      outcome,
      durationMs,
    })

    log.debug('Remediation completed', {
      id: remediation.id,
      status: outcome.status,
      durationMs,
    })
  }

  return records
}
