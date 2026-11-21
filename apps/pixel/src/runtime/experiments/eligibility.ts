/**
 * Per-pageview eligibility of one experiment — the gates that run BEFORE
 * bucketing, in 3.3.3 order (`belongsToExperiment` → `shouldTarget` →
 * `handleExclusions`) and with the SAME shared evaluators the SDK surfaces use
 * (`experiment-core` engine step b + `targeting.ts`), so a crobot experiment
 * decides identically on the pixel, `@testa-soft/react` and `@testa-soft/next`.
 *
 *   - `off_page`     — the URL does not match the experiment's page rules
 *                      (crobot experiment URL + url_match_type). The visitor is
 *                      neither bucketed, exposed nor mutated here; an already
 *                      assigned, session-live visitor still has goals armed.
 *   - `not_targeted` — a targeting group failed (AND across dimensions, OR
 *                      within one; unsupported dimensions fail closed).
 *   - `excluded`     — an exclusion rule matched (ANY; unsupported fail open).
 *                      Re-checked on every pageview, never persisted.
 *   - `audience`     — the 4.0 `audience` tree rejected the visitor.
 *   - `eligible`     — go on to bucketing.
 */

import type { ExperimentConfig } from '@testa-platform/shared-types';
import {
  type TargetingContext,
  exclusionsOf,
  isExcludedByRules,
  matchesPageRule,
  passesTargeting,
  targetingOf,
} from '@testa-soft/experiment-core';

export type Eligibility = 'off_page' | 'not_targeted' | 'excluded' | 'audience' | 'eligible';

export interface EligibilityDeps {
  /** Evaluates the 4.0 `audience` tree (pixel `rules/audience.ts`). */
  audience: (experiment: ExperimentConfig) => boolean;
}

export function eligibilityOf(
  experiment: ExperimentConfig,
  ctx: TargetingContext,
  deps: EligibilityDeps,
): Eligibility {
  if (!matchesPageRule(ctx.url, experiment.rules ?? [])) return 'off_page';
  if (!passesTargeting(targetingOf(experiment), ctx)) return 'not_targeted';
  if (isExcludedByRules(exclusionsOf(experiment), ctx)) return 'excluded';
  if (experiment.audience !== undefined && !deps.audience(experiment)) return 'audience';
  return 'eligible';
}
