/**
 * Per-experiment session + cached targeting-decision state, ported from crobot
 * 3.3.3's `_testa_ses_<id>` / `_testa_excl_<id>` model onto the ONE consolidated
 * `_testa_exp` cookie (its `excluded` + `sessionExp` fields).
 *
 * 3.3.3 evaluates targeting ONCE (first touch, site-wide) and caches the verdict
 * — eligible or excluded — then slides a session window while the visitor is
 * enrolled. This module is the storage for that:
 *
 *   - cached ELIGIBLE  → variation = ELIGIBLE_PENDING, sessionExp = cache expiry
 *   - cached EXCLUDED  → excluded = true,               sessionExp = cooldown expiry
 *   - ASSIGNED         → variation ≥ 0,                 sessionExp = session window
 *
 * `sessionExp` is epoch SECONDS (0 = "no expiry", for cookies written by a host
 * that doesn't set one). All windows slide: re-touching resets the expiry.
 */

import { ASSIGNMENT_COOKIE, ASSIGNMENT_TTL_SEC, type CookieStore } from './cookie-store.ts';
import {
  ELIGIBLE_PENDING_VARIATION_ID,
  EXCLUDED_VARIATION_ID,
  type ExpState,
  parsePacked,
  serializePacked,
} from './packed-cookie.ts';

/**
 * Session / exclusion-cooldown window length. crobot 3.3.3 uses 1h for the
 * session and 30d for the exclusion; we unify on a single sliding window,
 * default 30 minutes (overridable per-request via `EngineContext.sessionLengthSec`).
 */
export const SESSION_LENGTH_SEC = 30 * 60;

/** A cached state is live when it has no expiry (0) or expires in the future. */
export function isFresh(state: ExpState | undefined, nowSec: number): boolean {
  if (!state) return false;
  return state.sessionExp === 0 || state.sessionExp > nowSec;
}

/** Is this a real assignment (a bucketed variation, not a sentinel/exclusion)? */
export function isAssigned(state: ExpState | undefined): boolean {
  return !!state && !state.excluded && state.variation >= 0;
}

function write(store: CookieStore, expId: number, state: ExpState): void {
  const map = parsePacked(store.get(ASSIGNMENT_COOKIE));
  map.set(expId, state);
  store.set(ASSIGNMENT_COOKIE, serializePacked(map), { maxAgeSec: ASSIGNMENT_TTL_SEC });
}

/** Cache a first-touch targeting FAIL as a flat exclusion cooldown. */
export function cacheExclusion(store: CookieStore, expId: number, expiresSec: number): void {
  write(store, expId, { variation: EXCLUDED_VARIATION_ID, excluded: true, sessionExp: expiresSec });
}

/** Cache a first-touch targeting PASS (eligible, not yet bucketed). */
export function cacheEligible(store: CookieStore, expId: number, expiresSec: number): void {
  write(store, expId, {
    variation: ELIGIBLE_PENDING_VARIATION_ID,
    excluded: false,
    sessionExp: expiresSec,
  });
}

/** Stamp / slide the session window on an assigned entry (variation preserved). */
export function refreshSession(
  store: CookieStore,
  expId: number,
  variation: number,
  expiresSec: number,
): void {
  write(store, expId, { variation, excluded: false, sessionExp: expiresSec });
}

/**
 * True when the visitor is assigned AND their session window is still live —
 * the gate for attributing a conversion to the experiment.
 */
export function isSessionLive(
  store: CookieStore,
  experimentId: number | string,
  nowSec: number,
): boolean {
  const state = parsePacked(store.get(ASSIGNMENT_COOKIE)).get(Number(experimentId));
  return isAssigned(state) && isFresh(state, nowSec);
}
