/**
 * Client-side DOM experiment apply (cookie-first), framework-agnostic core.
 *
 * The middleware already bucketed the visitor and wrote the sticky `_testa_exp`
 * cookie (server-side, deterministic — no client coin-flip). This reads that
 * cookie, finds each experiment the visitor is assigned to a variant of, and
 * applies the variant's DOM changes via `@testa-soft/dom` — the same apply
 * engine the pixel uses. It NEVER re-buckets and never writes the cookie.
 *
 * Redirect changes are skipped here: those are the middleware's job (server-side
 * 307, flicker-free). This applies the css/html/text/attr/js/hide/insert/move
 * changes only.
 */

import type { ExperimentRule, ProjectConfig, VariationChange } from '@testa-platform/shared-types';
import { type Teardown, applyVariation } from '@testa-soft/dom';
import {
  type TargetingContext,
  isExcludedByRules,
  matchesPageRule,
  parsePacked,
} from '@testa-soft/experiment-core';

export interface AssignedExperiment {
  experimentId: number;
  variationId: number;
  /** The variant's non-redirect (DOM) changes, in config order. */
  changes: VariationChange[];
  /** The experiment's page rules — re-checked at every DOM touch (guard). */
  rules: ExperimentRule[];
}

/**
 * Resolve which experiments the `_testa_exp` cookie assigns this visitor to a
 * DOM variant of. Cookie-first: only experiments already present in the cookie
 * are considered; excluded/empty assignments and redirect-only variations are
 * dropped.
 */
export function resolveAssignedExperiments(
  config: ProjectConfig,
  cookieValue: string | null,
  currentUrl: string,
  exclusionCtx?: TargetingContext,
): AssignedExperiment[] {
  const map = parsePacked(cookieValue);
  if (map.size === 0) return [];

  const out: AssignedExperiment[] = [];
  for (const experiment of config.experiments) {
    if (experiment.status !== 'active') continue;
    // Page gate — apply a variation ONLY on the experiment's own page, the same
    // rule the middleware enrolls on. Assignment is sticky across the whole site;
    // the DOM change is not. Without this, an assigned variant leaks onto '/'.
    if (!matchesPageRule(currentUrl, experiment.rules)) continue;
    // Exclusion gate — like the middleware engine (3.3.3 `handleExclusions`),
    // exclusions re-evaluate on EVERY pageview, assigned or not: a match
    // suppresses the apply without touching the sticky assignment. Enforces
    // `dimension: 'experiment'` mutual exclusion at apply time.
    if (exclusionCtx && isExcludedByRules(experiment.exclusions, exclusionCtx)) continue;

    const state = map.get(Number(experiment.experiment_id));
    // Skip excluded + the eligible-but-unassigned sentinel (both variation < 0).
    if (!state || state.excluded || state.variation < 0) continue;

    const variation = experiment.variations.find((v) => v.variation_id === state.variation);
    if (!variation) continue;

    const domChanges = variation.changes.filter((c) => c.type !== 'redirect');
    if (domChanges.length === 0) continue;

    out.push({
      experimentId: experiment.experiment_id,
      variationId: state.variation,
      changes: domChanges,
      rules: experiment.rules,
    });
  }
  return out;
}

/**
 * Apply every assigned DOM experiment. Returns the collected teardowns (from the
 * DOM-watching appliers) so the caller can dispose them on the next cycle /
 * unmount. Applier errors are already isolated inside `applyVariation`.
 */
export function applyAssignedExperiments(
  config: ProjectConfig,
  cookieValue: string | null,
  currentUrl: string,
  exclusionCtx?: TargetingContext,
): Teardown[] {
  const teardowns: Teardown[] = [];
  for (const assigned of resolveAssignedExperiments(config, cookieValue, currentUrl, exclusionCtx)) {
    // The guard re-checks the page rule at the LIVE URL on every DOM touch —
    // the appliers' MutationObservers outlive soft navigations, and without
    // this they'd apply the variant to the next page's matching elements.
    teardowns.push(
      ...applyVariation(assigned.variationId, assigned.changes, {
        guard: () =>
          typeof window !== 'undefined' &&
          matchesPageRule(window.location.href, assigned.rules),
      }),
    );
  }
  return teardowns;
}

/** Reveal the anti-flicker shield raised by the head snippet, if present. */
export function revealShield(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __testa_shield?: { reveal: () => void } }).__testa_shield?.reveal();
}
