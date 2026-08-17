/**
 * Client-side DOM experiment apply (cookie-first), framework-agnostic core.
 *
 * The engine already bucketed the visitor and wrote the sticky `_testa_exp`
 * cookie. This reads that cookie, finds each experiment the visitor is assigned
 * to a variant of, and applies the variant's DOM changes via `@testa-soft/dom`
 * — the same apply engine the pixel + `@testa-soft/next` use. It NEVER
 * re-buckets and never writes the cookie.
 *
 * Redirect changes are skipped here (those are handled by a client-side
 * `location.replace` in `init.ts`). This applies the css/html/text/hide/insert/
 * move changes only.
 */

import type { ProjectConfig, VariationChange } from '@testa-platform/shared-types';
import { type Teardown, applyVariation } from '@testa-soft/dom';
import { EXCLUDED_VARIATION_ID, parsePacked } from '@testa-soft/experiment-core';

export interface AssignedExperiment {
  experimentId: number;
  variationId: number;
  /** The variant's non-redirect (DOM) changes, in config order. */
  changes: VariationChange[];
}

/**
 * Resolve which experiments the `_testa_exp` cookie assigns this visitor to a
 * DOM variant of. Cookie-first: only experiments already present in the cookie
 * are considered; excluded/empty assignments and redirect-only variations drop.
 */
export function resolveAssignedExperiments(
  config: ProjectConfig,
  cookieValue: string | null,
): AssignedExperiment[] {
  const map = parsePacked(cookieValue);
  if (map.size === 0) return [];

  const out: AssignedExperiment[] = [];
  for (const experiment of config.experiments) {
    if (experiment.status !== 'active') continue;
    const state = map.get(Number(experiment.experiment_id));
    if (!state || state.excluded || state.variation === EXCLUDED_VARIATION_ID) continue;

    const variation = experiment.variations.find((v) => v.variation_id === state.variation);
    if (!variation) continue;

    const domChanges = variation.changes.filter((c) => c.type !== 'redirect');
    if (domChanges.length === 0) continue;

    out.push({
      experimentId: experiment.experiment_id,
      variationId: state.variation,
      changes: domChanges,
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
): Teardown[] {
  const teardowns: Teardown[] = [];
  for (const assigned of resolveAssignedExperiments(config, cookieValue)) {
    teardowns.push(...applyVariation(assigned.variationId, assigned.changes));
  }
  return teardowns;
}

/** Reveal the anti-flicker shield raised by `<TestaShield/>` / `raiseShield`, if present. */
export function revealShield(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __testa_shield?: { reveal: () => void } }).__testa_shield?.reveal();
}
