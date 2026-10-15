/**
 * Fixture F3 (006-validation.md "Fixture F3 — stats golden"): exactly
 * 4,737 / 4,790 / 4,702 exposed visitors in variations 100 / 101 / 102 with
 * 115 / 137 / 109 purchasers. Events from X0's `buildF3WireEvents`; the
 * golden values are literals from the doc (V7, "F3 expected: planning + SRM").
 */

import type { WireEvent } from '../../cross/shared/f1-wire.ts';
import { F3_COUNTS, buildF3WireEvents } from '../../cross/shared/f3-wire.ts';
import { FIXTURES } from '../config.ts';

export const F3 = FIXTURES.F3;
export const F3_EXPERIMENT = 1903;
export const F3_DATE = '2026-10-01';
export { F3_COUNTS };

export const f3WireEvents = (): WireEvent[] => buildF3WireEvents(F3.projectId, F3_EXPERIMENT);

/** V7: variation 101 vs control 100. */
export const F3_STATS = {
  chance_to_beat: [0.902, 0.912],
  chance_to_be_best: [0.871, 0.881],
} as const;

/** SRM, weights ⅓ each: χ² 0.8277 ± 0.001, p 0.6611 ± 0.001, ok. */
export const F3_SRM = { chi2: 0.8277, p_value: 0.6611, tolerance: 0.001, ok: true } as const;

/** Planning: baseline 115 / 4,737, mde 0.15, confidence 0.95, power 0.8 → 30,084 ± 1. */
export const F3_PLANNING = {
  baseline: 0.024277,
  mde: 0.15,
  planned: 30_084,
  tolerance: 1,
  progress: 0.1563,
} as const;
