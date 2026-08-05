/**
 * Deterministic variation assignment over a `CookieStore`.
 *
 * Ported from `apps/pixel/src/runtime/experiments/traffic.ts` (bucketing rules
 * per [[architecture_variation_bucketing]]), reduced to what the split-URL MVP
 * needs and parametrized over the packed `_testa_exp` cookie:
 *
 *   1. Cookie-first. A stored, still-valid assignment (or a stored exclusion)
 *      wins without re-bucketing — this is what makes assignment sticky and
 *      SRM-safe across visits AND across hosts (pixel ⇄ middleware).
 *   2. Bucket = `xxhash32(visitorId:experimentId, SEED) mod 100`. Deterministic.
 *   3. Traffic allocation is consumed BEFORE variation weights:
 *        bucket [0, 100 - traffic)      → excluded (persisted)
 *        bucket [100 - traffic, 100)    → in experiment; bucket the remainder
 *                                         over cumulative variation weights.
 *
 * Frequency cap and mutex groups are intentionally NOT handled here (out of the
 * split-URL MVP scope; the pixel still owns them for 4.0).
 */

import { ASSIGNMENT_COOKIE, ASSIGNMENT_TTL_SEC, type CookieStore } from './cookie-store.ts';
import {
  EXCLUDED_VARIATION_ID,
  type ExpState,
  parsePacked,
  serializePacked,
} from './packed-cookie.ts';
import { SEED, xxhash32 } from './xxhash.ts';

export interface Variation {
  variation_id: number;
  /** 0..100; sum across all variations should be 100. */
  weight: number;
}

export interface Experiment {
  experiment_id: number;
  /** 0..100. Percent of the visitor pool that participates. */
  traffic_allocation: number;
  variations: Variation[];
}

export type ExcludedReason = 'traffic_allocation' | 'no_variations';

export interface AssignResult {
  variationId: number;
  isExcluded: boolean;
  excludedReason?: ExcludedReason;
  /** True when this call took the sticky cookie-first path (no re-bucket). */
  fromCookie: boolean;
}

export interface AssignContext {
  visitorId: string;
  /** Epoch ms; injectable for tests. Reserved for session windows. */
  now?: number;
}

/**
 * Decide (and persist) which variation this visitor sees for an experiment.
 *
 * Persists via `store.set(_testa_exp, …)` when it makes a fresh decision. Pass a
 * no-commit store (e.g. on a prefetch request) to compute without persisting.
 */
export function assign(
  experiment: Experiment,
  ctx: AssignContext,
  store: CookieStore,
): AssignResult {
  const expId = experiment.experiment_id;
  const map = parsePacked(store.get(ASSIGNMENT_COOKIE));
  const cached = map.get(expId);

  // ── 1. Cookie-first ────────────────────────────────────────────────────
  if (cached) {
    if (cached.excluded) {
      return {
        variationId: EXCLUDED_VARIATION_ID,
        isExcluded: true,
        excludedReason: 'traffic_allocation',
        fromCookie: true,
      };
    }
    if (experiment.variations.some((v) => v.variation_id === cached.variation)) {
      return { variationId: cached.variation, isExcluded: false, fromCookie: true };
    }
    // Stored variation no longer exists (config changed) → fall through to re-bucket.
  }

  if (experiment.variations.length === 0) {
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'no_variations',
      fromCookie: false,
    };
  }

  // ── 2. Bucket ──────────────────────────────────────────────────────────
  const bucket = bucketOf(ctx.visitorId, expId);
  const traffic = clamp(experiment.traffic_allocation, 0, 100);
  const excludedRangeEnd = 100 - traffic;

  if (bucket < excludedRangeEnd) {
    // Do NOT persist exclusion. Traffic-allocation exclusion is deterministically
    // re-derivable from the bucket, so storing it only pollutes the cookie with
    // experiments the visitor is not in. Only real assignments persist.
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'traffic_allocation',
      fromCookie: false,
    };
  }

  const variation = pickByWeight(experiment.variations, bucket - excludedRangeEnd, traffic);
  if (variation === null) {
    return {
      variationId: EXCLUDED_VARIATION_ID,
      isExcluded: true,
      excludedReason: 'no_variations',
      fromCookie: false,
    };
  }

  // ── 3. Persist ─────────────────────────────────────────────────────────
  // Preserve any existing sessionExp so we never clobber the pixel's session on
  // a domain where both the middleware and the pixel run.
  persist(store, map, expId, {
    variation: variation.variation_id,
    excluded: false,
    sessionExp: cached?.sessionExp ?? 0,
  });
  return { variationId: variation.variation_id, isExcluded: false, fromCookie: false };
}

export function bucketOf(visitorId: string, experimentId: number): number {
  return xxhash32(`${visitorId}:${experimentId}`, SEED) % 100;
}

/**
 * True when the packed cookie already holds a decision for this experiment
 * (a variation OR a persisted exclusion). Used to make assignment sticky: once
 * a visitor is in, targeting/exclusion entry gates are NOT re-evaluated.
 */
export function hasCachedAssignment(store: CookieStore, experimentId: number | string): boolean {
  return parsePacked(store.get(ASSIGNMENT_COOKIE)).has(Number(experimentId));
}

/**
 * Force a specific variation into the packed `_testa_exp` cookie (used for
 * inbound cross-domain continuity). `assign()`'s cookie-first lookup then
 * returns it instead of re-bucketing.
 */
export function applyAssignment(
  store: CookieStore,
  experimentId: number | string,
  variationId: number | string,
): void {
  const expId = Number(experimentId);
  const variation = Number(variationId);
  if (!Number.isFinite(expId) || !Number.isFinite(variation)) return;
  const map = parsePacked(store.get(ASSIGNMENT_COOKIE));
  map.set(expId, { variation, excluded: false, sessionExp: 0 });
  store.set(ASSIGNMENT_COOKIE, serializePacked(map), { maxAgeSec: ASSIGNMENT_TTL_SEC });
}

function persist(
  store: CookieStore,
  map: Map<number, ExpState>,
  expId: number,
  state: ExpState,
): void {
  map.set(expId, state);
  store.set(ASSIGNMENT_COOKIE, serializePacked(map), { maxAgeSec: ASSIGNMENT_TTL_SEC });
}

/**
 * Split the included visitors across variations by weight.
 *
 * `bucketWithinIncluded` is in `[0, includedWidth)` where `includedWidth` is the
 * traffic allocation (the width of the non-excluded bucket range). We map it to
 * `[0, totalWeight)` by dividing by `includedWidth` — NOT by 100. Dividing by
 * 100 starves later variations whenever traffic < 100 (e.g. at traffic=42 the
 * target never exceeds 42, so a 50/50 split only ever returns the first
 * variation). This keeps the weight split correct at any traffic allocation.
 */
export function pickByWeight(
  variations: Variation[],
  bucketWithinIncluded: number,
  includedWidth: number,
): Variation | null {
  // Sort by variation_id so weights map to deterministic ranges even if the
  // admin reorders the list in the UI.
  const sorted = [...variations].sort((a, b) => a.variation_id - b.variation_id);
  const total = sorted.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0 || includedWidth <= 0) return null;
  const target = (bucketWithinIncluded * total) / includedWidth;
  let cumulative = 0;
  for (const v of sorted) {
    cumulative += v.weight;
    if (target < cumulative) return v;
  }
  return sorted[sorted.length - 1] ?? null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
