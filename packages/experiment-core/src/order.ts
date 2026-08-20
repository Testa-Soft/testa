/**
 * Experiment randomizer — 3.3.3 parity for `shuffleArray` in `init`.
 *
 * 3.3.3 Fisher-Yates-shuffles `project.experiments` with `Math.random()` on
 * every page load. Combined with mutual `exclusions[]` and 100% traffic on
 * both experiments, whichever lands FIRST captures a new visitor and the
 * exclusion locks the other out — a 50/50 split BETWEEN experiments without
 * touching traffic allocation.
 *
 * This port keeps the statistics but replaces `Math.random()` with a
 * DETERMINISTIC per-visitor order, for the same reason variation bucketing
 * uses xxhash32 instead of a coin flip:
 *   - no SRM: the shuffle is a property of the visitor, not of the request;
 *   - no races: concurrent middleware invocations (prefetch + navigation) see
 *     the same order, so they can never each enroll a different experiment;
 *   - across visitors the order is still uniformly random (hash-keyed sort).
 *
 * Assigned visitors are unaffected either way: assignment is cookie-first and
 * exclusions re-evaluate per pageview, so order only decides who captures a
 * NEW visitor.
 */

import { xxhash32 } from './xxhash.ts';

/**
 * Return a NEW array with the experiments in this visitor's shuffled order.
 * Sorting by `xxhash32(visitorId:experimentId:order)` yields an order that is
 * stable per visitor and uniformly random across visitors. Ties (hash
 * collisions) fall back to experiment id so the sort stays total.
 */
export function shuffleForVisitor<T extends { experiment_id: number }>(
  experiments: readonly T[],
  visitorId: string,
): T[] {
  const keyed = experiments.map((experiment) => ({
    experiment,
    key: xxhash32(`${visitorId}:${experiment.experiment_id}:order`),
  }));
  keyed.sort(
    (a, b) => a.key - b.key || a.experiment.experiment_id - b.experiment.experiment_id,
  );
  return keyed.map((k) => k.experiment);
}
