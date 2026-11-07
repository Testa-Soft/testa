/**
 * The visitor's tracking consent, as the customer's CMP reports it.
 *
 * Until reported it is `unknown`, which — like `denied` — keeps everything we
 * store session-scoped (see experiment-core/consent.ts), unless the server
 * side was told and left a grant marker (`effectiveConsent`). Set it through the
 * `consent` prop on `<TestaProvider>`, or with `setConsent()` from a CMP
 * callback outside React. Module-level because every store a page builds
 * (provider, tracking, cold fallback) must agree on one answer.
 */
import type { ConsentState } from '@testa-platform/shared-types';
import {
  type CookieStore,
  PERSISTENCE_COOKIE,
  type Persistence,
  effectiveConsent,
  persistenceFor,
  syncPersistence,
} from '@testa-soft/experiment-core';

type Listener = (state: ConsentState) => void;

/** `undefined` = the customer has not reported consent on this side. */
let _consent: ConsentState | undefined;
const listeners = new Set<Listener>();

export function getConsent(): ConsentState {
  return _consent ?? 'unknown';
}

/** Consent to act on, given the persistence marker the store carries. */
export function resolveConsent(marker: string | null): ConsentState {
  return effectiveConsent(_consent, marker);
}

/** Storage lifetime the current consent allows. */
export function currentPersistence(marker: string | null = null): Persistence {
  return persistenceFor(resolveConsent(marker));
}

/** Record a consent decision; mounted providers promote/demote stored ids at once. */
export function setConsent(state: ConsentState): void {
  if (state === _consent) return;
  _consent = state;
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // one broken subscriber must not block the others
    }
  }
}

/** Subscribe to consent changes. Returns an unsubscribe. */
export function onConsentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keep `store`'s long-lived values at the lifetime consent allows: align them
 * now (demoting cookies written before this release), then promote/demote on
 * every later consent change. Returns a teardown. Never throws.
 */
export function watchConsent(store: CookieStore): () => void {
  const sync = (): void => {
    try {
      syncPersistence(store, currentPersistence(store.get(PERSISTENCE_COOKIE)));
    } catch {
      // storage blocked: nothing to promote or demote
    }
  };
  sync();
  return onConsentChange(sync);
}

/** Test seam. */
export function __resetConsentForTests(): void {
  _consent = undefined;
  listeners.clear();
}
