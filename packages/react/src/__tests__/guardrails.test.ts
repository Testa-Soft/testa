// @vitest-environment happy-dom
/**
 * Defensive invariants for clients that cannot be trusted to store cookies —
 * in-app webviews above all, where storage restrictions make a write vanish
 * without an error. Each of these turns a silent, self-repeating wrong answer
 * into a visible no-op.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { UUID_COOKIE, bucketOf } from '@testa-soft/experiment-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';
import { ensureVisitorId, initTesta } from '../init.ts';

/** A store whose writes never land — an in-app webview with storage blocked. */
function deafStore() {
  return {
    get: () => null,
    set: () => {
      /* accepted, then discarded — exactly what document.cookie does */
    },
  };
}

const config = (): ProjectConfig => ({
  project_id: 1,
  slug: 'acme',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '',
  config_hash: 'h1',
  experiments: [
    {
      experiment_id: 101,
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/checkout' }],
      goals: [],
      variations: [
        { variation_id: 0, weight: 50, changes: [] },
        {
          variation_id: 1,
          weight: 50,
          changes: [
            {
              type: 'redirect',
              from_url: 'https://acme.com/checkout',
              to_url: 'https://acme.com/checkout-v2',
            },
          ],
        },
      ],
    },
  ],
});

describe('an empty visitor id is a constant, not a coin flip', () => {
  it('buckets every visitor identically — the reason we must not use it', () => {
    // Not a bug being asserted; the property that makes failing closed necessary.
    expect(bucketOf('', 101)).toBe(bucketOf('', 101));
    expect(new Set([0, 1, 2, 3].map((n) => bucketOf('', n))).size).toBeGreaterThan(1);
  });
});

describe('ensureVisitorId', () => {
  it('returns empty when the write did not persist', () => {
    expect(ensureVisitorId(deafStore())).toBe('');
  });

  it('returns the id when it did', () => {
    const store = new DocumentCookieStore({ secure: false });
    const id = ensureVisitorId(store);
    expect(id).not.toBe('');
    expect(store.get(UUID_COOKIE)).toBe(id);
  });
});

describe('initTesta with no persistable visitor id', () => {
  it('decides nothing: no assignment, no redirect, no exposure', async () => {
    let navigated: string | null = null;
    const result = await initTesta({
      config: config(),
      currentUrl: 'https://acme.com/checkout',
      store: deafStore(),
      tracking: false,
      navigate: (u) => {
        navigated = u;
      },
    });
    expect(result.applied).toEqual([]);
    expect(result.redirected).toBe(false);
    expect(navigated).toBeNull();
  });

  it('still decides normally when cookies work', async () => {
    const result = await initTesta({
      config: config(),
      currentUrl: 'https://acme.com/checkout',
      store: new DocumentCookieStore({ secure: false }),
      tracking: false,
      navigate: () => {},
    });
    expect(result.applied.length).toBe(1);
  });
});

describe('DocumentCookieStore reports refused writes', () => {
  beforeEach(() => {
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=;max-age=0;path=/`;
    }
  });

  it('counts a write the browser rejected (domain it may not set)', () => {
    const store = new DocumentCookieStore({ secure: false, domain: 'not-our-domain.invalid' });
    store.set('probe', 'v', { maxAgeSec: 60 });
    expect(store.failedWrites()).toBe(1);
  });

  it('counts nothing when writes land', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('probe', 'v', { maxAgeSec: 60 });
    expect(store.failedWrites()).toBe(0);
  });
});

/**
 * Storage mirror — 3.3.3 `helpers.getCookie` parity. The reason the legacy pixel
 * reconciles with first-party analytics on cookie-hostile traffic and a
 * cookie-only client does not: the visitor id survives in Web Storage, so the
 * same human is recognised instead of re-minted on every pageview.
 */
describe('cookie → localStorage → sessionStorage cascade', () => {
  beforeEach(() => {
    __resetMemoryTier();
    localStorage.clear();
    sessionStorage.clear();
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=;max-age=0;path=/`;
    }
  });

  it('recovers a value whose cookie is gone', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'visitor-A', { maxAgeSec: 3600 });
    document.cookie = `${UUID_COOKIE}=;max-age=0;path=/`; // webview drops it
    expect(store.get(UUID_COOKIE)).toBe('visitor-A');
    expect(store.recoveries()).toBe(1);
  });

  it('keeps the SAME id across pageviews when cookies never stick', () => {
    const ids = [0, 1, 2].map(() => {
      const store = new DocumentCookieStore({ secure: false }); // fresh per "pageview"
      document.cookie = `${UUID_COOKIE}=;max-age=0;path=/`;
      return ensureVisitorId(store);
    });
    expect(new Set(ids).size).toBe(1); // one visitor, not three
  });

  it('IDENTITY: the established id wins over a re-minted cookie, and corrects it', () => {
    // The server could not see the visitor's cookie, so it minted a new id.
    // Adopting it would make one visitor into two — and the server would never
    // learn otherwise, because the cookie is the only channel it can read.
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'established', { maxAgeSec: 3600 });
    document.cookie = `${UUID_COOKIE}=server-minted;path=/`;

    expect(store.get(UUID_COOKIE)).toBe('established');
    // …and the cookie is corrected, so the NEXT request converges the server.
    expect(document.cookie).toContain(`${UUID_COOKIE}=established`);
  });

  it('STATE: the server-owned cookie wins for _testa_exp', () => {
    // `_testa_exp` legitimately changes on every server pass — a slid session
    // window, a new assignment. Here the mirror is only a fallback.
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_exp', '438.1.0.111', { maxAgeSec: 3600 });
    document.cookie = '_testa_exp=438.1.0.999;path=/';
    expect(store.get('_testa_exp')).toBe('438.1.0.999');
  });

  it('records how long a value has been held, so the ordering is auditable', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'established', { maxAgeSec: 3600 });
    const stamp = JSON.parse(localStorage.getItem(UUID_COOKIE) as string).firstSeenAt;
    expect(stamp).toBeGreaterThan(0);
    // Re-writing the SAME value must not restart its clock — otherwise every
    // pageview would make an established id look freshly minted.
    store.set(UUID_COOKIE, 'established', { maxAgeSec: 3600 });
    expect(JSON.parse(localStorage.getItem(UUID_COOKIE) as string).firstSeenAt).toBe(stamp);
  });

  it('agreement is a no-op — no needless cookie writes', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'same', { maxAgeSec: 3600 });
    const before = store.recoveries();
    expect(store.get(UUID_COOKIE)).toBe('same');
    expect(store.recoveries()).toBe(before);
  });

  it('a delete clears the mirror too — no resurrection', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_tmp', 'v', { maxAgeSec: 100 });
    store.set('_testa_tmp', '', { maxAgeSec: 0 });
    expect(store.get('_testa_tmp')).toBeNull();
  });

  it('mirrorToStorage:false stays strictly cookie-only', () => {
    const store = new DocumentCookieStore({ secure: false, mirrorToStorage: false });
    store.set(UUID_COOKIE, 'x', { maxAgeSec: 3600 });
    document.cookie = `${UUID_COOKIE}=;max-age=0;path=/`;
    expect(store.get(UUID_COOKIE)).toBeNull();
  });
});

/**
 * Promotion is the half that matters. A read-only fallback fixes the client and
 * leaves the SERVER blind — it only sees cookies, so it keeps minting a fresh id
 * on every request no matter what the browser knows. Writing the recovered value
 * back into the cookie is what makes the next request identify the visitor.
 */
describe('the cascade promotes, it does not just fall back', () => {
  beforeEach(() => {
    __resetMemoryTier();
    localStorage.clear();
    sessionStorage.clear();
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=;max-age=0;path=/`;
    }
  });

  it('restores the COOKIE from storage, so the next request carries it', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'visitor-A', { maxAgeSec: 3600 });
    document.cookie = `${UUID_COOKIE}=;max-age=0;path=/`; // jar wiped mid-session

    expect(store.get(UUID_COOKIE)).toBe('visitor-A');
    // The point: not just the return value — the cookie itself is back.
    expect(document.cookie).toContain(`${UUID_COOKIE}=visitor-A`);
    expect(store.recoveries()).toBe(1);
  });

  it('a server-written cookie still wins over the mirror', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_exp', '101.1.0.0', { maxAgeSec: 3600 });
    document.cookie = '_testa_exp=101.2.0.999;path=/'; // middleware refreshed it
    expect(store.get('_testa_exp')).toBe('101.2.0.999');
  });

  it('reads a bare string the legacy 3.3.3 pixel mirrored', () => {
    localStorage.setItem(UUID_COOKIE, 'pixel-written-id');
    const store = new DocumentCookieStore({ secure: false });
    expect(store.get(UUID_COOKIE)).toBe('pixel-written-id');
    expect(document.cookie).toContain(`${UUID_COOKIE}=pixel-written-id`);
  });

  it('does not resurrect an expired mirror', () => {
    const store = new DocumentCookieStore({ secure: false });
    localStorage.setItem(UUID_COOKIE, JSON.stringify({ value: 'stale', expiresAt: 1 }));
    expect(store.get(UUID_COOKIE)).toBeNull();
  });

  it('survives soft navs through the memory tier when both cookie and storage are dead', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'visitor-B', { maxAgeSec: 3600 });
    document.cookie = `${UUID_COOKIE}=;max-age=0;path=/`;
    localStorage.clear();
    sessionStorage.clear();
    // A new store per render, as the provider constructs it.
    expect(new DocumentCookieStore({ secure: false }).get(UUID_COOKIE)).toBe('visitor-B');
  });
});
