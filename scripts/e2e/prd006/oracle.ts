/**
 * PRD-006 reference oracle — a faithful TypeScript port of the modelling code
 * in `docs/reference/samples/generate.py` (model, daily_summary, products,
 * distributions, srm, health), including Python's rounding / summation /
 * ordering semantics so outputs match the committed goldens exactly.
 *
 * One intentional deviation: `health()` counts raw attributed events
 * (reload duplicates included) — see `oracle/health.ts`.
 */

export type { DistributionsOptions } from './oracle/distributions.ts';
export { distributions } from './oracle/distributions.ts';
export type { SrmResult } from './oracle/health.ts';
export { health, srm } from './oracle/health.ts';
export type { Exposure, Model } from './oracle/model.ts';
export { buildModel, ORACLE_FX } from './oracle/model.ts';
export type { ProductsOptions, PurchaseType } from './oracle/products.ts';
export { products } from './oracle/products.ts';
export { parseTs, pyRound, pySum, r6, ratio } from './oracle/pymath.ts';
export type {
  DailySummary,
  DailySummaryOptions,
  DailySummaryRow,
} from './oracle/summary.ts';
export { dailySummary, SUMMARY_KEYS, summaryValues } from './oracle/summary.ts';
