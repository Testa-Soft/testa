# Phase 5 — sessions

Replaced by **work packages**: `tasks/orchestration/PACKAGES.md` (both repos),
dispatched by `tasks/orchestration/ORCHESTRATOR.md`. Per-task rules stay in
`LOOP.md`.

## Stats interface stub (created in P0 by 5.1, replaced in P3)

`apps/collector/src/stats/index.ts` exports these types and signatures, with
bodies that throw `new Error('not implemented: P3')`. P3 replaces the bodies
and keeps the signatures.

```ts
export type StatModel = 'beta' | 'normal';
export interface VariationInput {
  variation: number;
  n: number;                                   // denominator: visitors, orders, units…
  x?: number;                                  // successes (beta)
  sum?: number; sumSq?: number;                // normal: Σx, Σx²
}
export interface StatsRequest { model: StatModel; control: number; draws: number; seedKey: string; confidence?: number; direction?: 'higher' | 'lower'; variations: VariationInput[]; }
export interface VariationStats {
  chance_to_beat_control?: number; chance_to_be_best: number;
  lift?: number; lift_ci?: [number, number]; expected_loss?: number; insufficient_data?: true;
}
export function computeStats(req: StatsRequest): Map<number, VariationStats>;
export function sampleSizeTwoProportion(a: { baseline: number; mde: number; alpha: number; power: number }): number;
export function srmChiSquare(observed: number[], weights: number[]): { chi2: number; p_value: number };
```
