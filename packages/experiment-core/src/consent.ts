/**
 * Consent-driven storage persistence, shared by every `CookieStore`.
 *
 * DEFAULT IS SESSION-SCOPED. Until the customer tells us the visitor granted
 * consent, nothing we store outlives the browser session: long-lived cookies
 * are written as SESSION cookies (no `Max-Age`) and the client mirrors to
 * `sessionStorage` only, never `localStorage`. Session cookies — not
 * sessionStorage alone — because the middleware must still see the visitor id
 * and assignment to bucket server-side, and because every tab of the session
 * has to land in the same variation.
 *
 * Bucketing is `hash(visitorId:experimentId)`, so within a session the
 * visitor is bucketed exactly as before; only cross-session continuity is lost.
 *
 * ON GRANT the values already held are PROMOTED (re-written with their full
 * lifetime) rather than re-minted: a visitor who accepts mid-session keeps the
 * id and variation they already have. ON REVOKE they are demoted back.
 */
import type { ConsentState } from '@testa-platform/shared-types';
import {
  ASSIGNMENT_COOKIE,
  ASSIGNMENT_TTL_SEC,
  type CookieStore,
  SECONDS_PER_DAY,
  UUID_BACKUP_COOKIE,
  UUID_COOKIE,
  UUID_TTL_SEC,
} from './cookie-store.ts';

export type Persistence = 'session' | 'persistent';

/**
 * Marker of the persistence the stored values were last written with: `p`
 * (persistent) or `s` (session). Neither the server nor the client can read a
 * cookie's expiry back, so without it they could not tell whether a carried
 * value still needs promoting or demoting.
 */
export const PERSISTENCE_COOKIE = '_testa_persist';

/**
 * In session mode a cookie meant to live at most this long keeps its own
 * `Max-Age` (it already expires sooner than anything session-scoped need to);
 * anything longer becomes a session cookie.
 */
export const SESSION_MAX_AGE_LIMIT_SEC = SECONDS_PER_DAY;

/** Only an explicit grant persists; `denied`, `unknown` and unset stay session-scoped. */
export function persistenceFor(consent: ConsentState | undefined): Persistence {
  return consent === 'granted' ? 'persistent' : 'session';
}

/**
 * The consent to act on. An `explicit` answer (the customer told THIS side)
 * always wins. Without one, defer to the marker the other side wrote: a
 * customer may report consent only on the client (the provider prop) or only
 * on the server (the middleware option), and the side that was not told must
 * not undo the side that was — or the two would demote and re-promote the
 * visitor's cookies on every request.
 */
export function effectiveConsent(
  explicit: ConsentState | undefined,
  marker: string | null,
): ConsentState {
  return explicit ?? (marker === MARK.persistent ? 'granted' : 'unknown');
}

/**
 * The `Max-Age` to actually emit, or `undefined` for a session cookie. A
 * delete (`0`) is always honoured.
 */
export function cookieMaxAge(maxAgeSec: number, persistence: Persistence): number | undefined {
  if (persistence === 'persistent' || maxAgeSec <= SESSION_MAX_AGE_LIMIT_SEC) return maxAgeSec;
  return undefined;
}

/** The long-lived values whose lifetime depends on consent. */
const LONG_LIVED: ReadonlyArray<{ name: string; ttl: number; httpOnly?: true }> = [
  { name: UUID_COOKIE, ttl: UUID_TTL_SEC },
  // Invisible to a client store (HttpOnly), so only the server re-writes it.
  { name: UUID_BACKUP_COOKIE, ttl: UUID_TTL_SEC, httpOnly: true },
  { name: ASSIGNMENT_COOKIE, ttl: ASSIGNMENT_TTL_SEC },
];

const MARK: Record<Persistence, string> = { persistent: 'p', session: 's' };

/**
 * Re-write the long-lived values the store already holds so their lifetime
 * matches `persistence` — the store applies the session/persistent rule on
 * write. No-op once the marker says they already match. Returns whether
 * anything was re-written.
 *
 * Covers the first request after this release too: a returning visitor
 * carrying pre-consent 400-day cookies has no marker and is demoted once.
 */
export function syncPersistence(store: CookieStore, persistence: Persistence): boolean {
  if (store.get(PERSISTENCE_COOKIE) === MARK[persistence]) return false;
  for (const { name, ttl, httpOnly } of LONG_LIVED) {
    const value = store.get(name);
    if (value) store.set(name, value, { maxAgeSec: ttl, ...(httpOnly ? { httpOnly } : {}) });
  }
  store.set(PERSISTENCE_COOKIE, MARK[persistence], { maxAgeSec: UUID_TTL_SEC });
  return true;
}
