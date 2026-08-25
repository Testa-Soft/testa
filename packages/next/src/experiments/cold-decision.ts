/**
 * "Does the CLIENT own this pageview?"
 *
 * The proxy decides server-side whenever it has a config in memory. On a cold
 * isolate (`decisions: 'hybrid'`) it has none, so it passes the request through
 * and hands that ONE pageview to the client — no assignment written, no
 * redirect issued. Something on the client has to pick it up, or the pageview
 * is silently unexperimented: no bucketing, no split-URL redirect, and (because
 * the DOM apply is cookie-first) no DOM changes either, on that visit and every
 * later one until an isolate happens to be warm.
 *
 * Three triggers, each a case the server demonstrably did not handle:
 *
 *   1. NO SERVER CONFIG — the RSC couldn't resolve one (unreachable from the
 *      server, a null baked into a static prerender, the fetch budget), so
 *      nothing server-side decided anything and the client fetched its own.
 *   2. COOKIE GAP — an active experiment whose page rule matches this URL has
 *      no entry in `_testa_exp`. Nothing decided it, so we do.
 *   3. UNHONOURED REDIRECT — the cookie pins the visitor to a split-URL variant
 *      whose `from_url` matches where we are, i.e. they are looking at the
 *      CONTROL page while counted in the variant. The proxy would have issued
 *      that 307; it didn't, so it never saw this request.
 *
 * Trigger 3 is the one that survives a warm cache: assignment is sticky, so
 * once a visitor is pinned to a redirect variant a cookie gap never appears
 * again, and a cookie-first client (which skips redirect changes by design)
 * would leave them on the control page forever.
 *
 * Deliberately stateless — no marker cookie, no header from the proxy — so it
 * also covers what a marker never would: a proxy that never warms, a bad
 * `matcher`, or no middleware deployed at all. It cannot double-bucket, because
 * bucketing is a deterministic hash of `visitorId:experimentId`: the client
 * reaches the same variation the server would have, and a real assignment in
 * the cookie is never re-rolled — the engine honours it cookie-first. A visitor
 * the server left out (traffic allocation, a cached exclusion in cooldown)
 * simply gets that same verdict again when the client runs the engine.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { isAssigned, matchesPageRule, parsePacked } from '@testa-soft/experiment-core';
import { resolveGuardRedirect } from '../router-guard/use-cookie-assignment.ts';

export interface ClientDecisionInput {
  config: ProjectConfig;
  /** Raw `_testa_exp` value, or null. */
  cookieValue: string | null;
  /** The absolute URL of this pageview. */
  currentUrl: string;
  /**
   * Did the config come from the SERVER? False means the client fetched it
   * itself, which is proof the server had none to decide with.
   */
  hasServerConfig: boolean;
}

export function clientOwnsDecision(input: ClientDecisionInput): boolean {
  const { config, cookieValue, currentUrl } = input;

  // 1. The server had no config: it cannot have decided anything.
  if (!input.hasServerConfig) return true;

  // 2. An active, page-matching experiment with no ASSIGNMENT — the engine's own
  // notion (`isAssigned`), not merely "has a cookie entry". The parked
  // eligible-pending sentinel is an entry but explicitly not a decision: the
  // engine buckets it the moment the visitor reaches the experiment's page, so
  // treating it as decided would strand those visitors on the control forever.
  const decided = parsePacked(cookieValue);
  const gap = config.experiments.some(
    (experiment) =>
      experiment.status === 'active' &&
      matchesPageRule(currentUrl, experiment.rules) &&
      !isAssigned(decided.get(Number(experiment.experiment_id))),
  );
  if (gap) return true;

  // 3. A pinned split-URL variant that was never honoured. `resolveGuardRedirect`
  // is the same cookie-first resolver the router guard uses, and its
  // already-at-destination check is what keeps this from looping.
  return resolveGuardRedirect({ config, currentUrl, cookieValue }) !== null;
}
