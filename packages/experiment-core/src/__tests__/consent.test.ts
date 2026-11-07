import { describe, expect, it } from 'vitest';
import {
  PERSISTENCE_COOKIE,
  cookieMaxAge,
  effectiveConsent,
  persistenceFor,
  syncPersistence,
} from '../consent.ts';
import type { CookieSetOptions, CookieStore } from '../cookie-store.ts';

function recordingStore(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const writes: Array<{ name: string; value: string; opts: CookieSetOptions }> = [];
  const store: CookieStore = {
    get: (n) => jar.get(n) ?? null,
    set: (name, value, opts) => {
      jar.set(name, value);
      writes.push({ name, value, opts });
    },
  };
  return { store, writes };
}

describe('persistenceFor', () => {
  it('persists only on an explicit grant', () => {
    expect(persistenceFor('granted')).toBe('persistent');
    expect(persistenceFor('denied')).toBe('session');
    expect(persistenceFor('unknown')).toBe('session');
    expect(persistenceFor(undefined)).toBe('session');
  });
});

describe('cookieMaxAge', () => {
  it('turns long-lived cookies into session cookies in session mode', () => {
    expect(cookieMaxAge(400 * 86400, 'session')).toBeUndefined();
    expect(cookieMaxAge(400 * 86400, 'persistent')).toBe(400 * 86400);
  });

  it('keeps short lifetimes and deletes in session mode', () => {
    expect(cookieMaxAge(1800, 'session')).toBe(1800);
    expect(cookieMaxAge(0, 'session')).toBe(0);
  });
});

describe('syncPersistence', () => {
  it('re-writes held values with their full TTL and marks the mode', () => {
    const { store, writes } = recordingStore({ _testa_uuid: 'u1', _testa_exp: 'packed' });
    expect(syncPersistence(store, 'persistent')).toBe(true);
    expect(writes.map((w) => [w.name, w.value])).toEqual([
      ['_testa_uuid', 'u1'],
      ['_testa_exp', 'packed'],
      [PERSISTENCE_COOKIE, 'p'],
    ]);
  });

  it('re-writes the server-owned id copy as HttpOnly', () => {
    const { store, writes } = recordingStore({ _testa_uuid_s: 'u1' });
    syncPersistence(store, 'session');
    expect(writes[0]).toMatchObject({ name: '_testa_uuid_s', opts: { httpOnly: true } });
  });

  it('is a no-op once the marker matches', () => {
    const { store, writes } = recordingStore({ _testa_uuid: 'u1', [PERSISTENCE_COOKIE]: 's' });
    expect(syncPersistence(store, 'session')).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('effectiveConsent', () => {
  it('lets an explicit answer win', () => {
    expect(effectiveConsent('denied', 'p')).toBe('denied');
    expect(effectiveConsent('granted', 's')).toBe('granted');
  });

  it("defers to the other side's marker when not told", () => {
    expect(effectiveConsent(undefined, 'p')).toBe('granted');
    expect(effectiveConsent(undefined, 's')).toBe('unknown');
    expect(effectiveConsent(undefined, null)).toBe('unknown');
  });
});
