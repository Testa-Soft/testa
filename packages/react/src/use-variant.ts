/**
 * `useTestaVariant` — the ROBUST, code-based experiment path for React SPAs.
 *
 * DOM-mutation experiments (`applyAssignedExperiments`) fight React
 * reconciliation: React can re-render and wipe an applied change. For anything
 * the app itself renders, read the assigned variation here and branch in JSX —
 * it survives reconciliation because React owns the output.
 *
 * Cookie-first: the variation comes from the sticky `_testa_exp` assignment
 * (surfaced through `<TestaProvider/>`'s context), never a client coin-flip.
 * Returns `{ variationId: null, isControl: false }` when the visitor isn't
 * assigned (not enrolled / excluded / off-page).
 */

import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { EXCLUDED_VARIATION_ID, parsePacked } from '@testa-soft/experiment-core';
import { useContext } from 'react';
import { TestaContext } from './context.ts';

export interface VariantResult {
  variationId: number | null;
  isControl: boolean;
}

/** Parse the packed `_testa_exp` cookie into an experimentId → variationId map. */
export function buildAssignmentMap(cookieValue: string | null): Map<number, number> {
  const packed = parsePacked(cookieValue);
  const map = new Map<number, number>();
  for (const [expId, state] of packed) {
    if (state.excluded || state.variation === EXCLUDED_VARIATION_ID) continue;
    map.set(expId, state.variation);
  }
  return map;
}

/** The control variation id — the lowest variation_id (the "original"). */
export function controlVariationId(exp: ExperimentConfig): number | null {
  let min: number | null = null;
  for (const v of exp.variations) {
    if (min === null || v.variation_id < min) min = v.variation_id;
  }
  return min;
}

/** Pure resolver — the hook is a thin wrapper reading these from context. */
export function resolveVariant(
  config: ProjectConfig | null,
  assignments: ReadonlyMap<number, number>,
  experimentId: number,
): VariantResult {
  const variationId = assignments.get(experimentId) ?? null;
  if (variationId === null || !config) return { variationId: null, isControl: false };
  const exp = config.experiments.find((e) => e.experiment_id === experimentId);
  const control = exp ? controlVariationId(exp) : null;
  return { variationId, isControl: control !== null && variationId === control };
}

export function useTestaVariant(experimentId: number): VariantResult {
  const ctx = useContext(TestaContext);
  return resolveVariant(ctx.config, ctx.assignments, experimentId);
}
