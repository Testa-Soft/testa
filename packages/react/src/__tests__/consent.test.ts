// @vitest-environment happy-dom
import {
  ASSIGNMENT_COOKIE,
  PERSISTENCE_COOKIE,
  UUID_COOKIE,
  syncPersistence,
} from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetConsentForTests,
  currentPersistence,
  getConsent,
  onConsentChange,
  setConsent,
  watchConsent,
} from '../consent.ts';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';

const DAY = 86_400;

/** Every raw `document.cookie` assignment, attributes included. */
function cookieWrites(): string[] {
  const writes: string[] = [];
  let proto: object | null = Object.getPrototypeOf(document);
  let desc: PropertyDescriptor | undefined;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, 'cookie');
    proto = Object.getPrototypeOf(proto);
  }
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => desc?.get?.call(document),
    set: (v: string) => {
      writes.push(v);
      desc?.set?.call(document, v);
    },
  });
  return writes;
}

function clearJar(): void {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
}

beforeEach(() => {
  clearJar();
  __resetMemoryTier();
  __resetConsentForTests();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  // Drop the instance-level spy accessor; the prototype one takes over again.
  Reflect.deleteProperty(document, 'cookie');
});

describe('consent state', () => {
  it('defaults to unknown → session-scoped', () => {
    expect(getConsent()).toBe('unknown');
    expect(currentPersistence()).toBe('session');
  });

  it('notifies subscribers only on a real change', () => {
    const seen: string[] = [];
    const off = onConsentChange((s) => seen.push(s));
    setConsent('granted');
    setConsent('granted');
    setConsent('denied');
    off();
    setConsent('granted');
    expect(seen).toEqual(['granted', 'denied']);
    expect(currentPersistence()).toBe('persistent');
  });
});

describe('DocumentCookieStore without consent', () => {
  it('writes session cookies and mirrors to sessionStorage only', () => {
    const writes = cookieWrites();
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'v1', { maxAgeSec: 400 * DAY });

    expect(writes[0]).toContain(`${UUID_COOKIE}=v1`);
    expect(writes[0]).not.toContain('max-age');
    expect(localStorage.getItem(UUID_COOKIE)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(UUID_COOKIE) as string).value).toBe('v1');
  });

  it('keeps short lifetimes on session-mode cookies', () => {
    const writes = cookieWrites();
    new DocumentCookieStore({ secure: false }).set('_testa_sid', 's', { maxAgeSec: 1800 });
    expect(writes[0]).toContain('max-age=1800');
  });

  it('keeps the same bucket across pageviews of the session (sessionStorage recovery)', () => {
    new DocumentCookieStore({ secure: false }).set(UUID_COOKIE, 'v1', { maxAgeSec: 400 * DAY });
    clearJar(); // cookie jar dropped (webview), memory gone (full reload)
    __resetMemoryTier();
    expect(new DocumentCookieStore({ secure: false }).get(UUID_COOKIE)).toBe('v1');
  });

  it('never reads a persistent localStorage copy', () => {
    localStorage.setItem(UUID_COOKIE, 'from-an-earlier-grant');
    expect(new DocumentCookieStore({ secure: false }).get(UUID_COOKIE)).toBeNull();
  });
});

describe('promotion on grant, demotion on revoke', () => {
  it('re-writes the held id + assignment persistently, without re-minting', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'v1', { maxAgeSec: 400 * DAY });
    store.set(ASSIGNMENT_COOKIE, 'packed', { maxAgeSec: 30 * DAY });
    syncPersistence(store, 'session');

    const writes = cookieWrites();
    setConsent('granted');
    expect(syncPersistence(store, 'persistent')).toBe(true);

    expect(writes.find((w) => w.startsWith(`${UUID_COOKIE}=v1`))).toContain(`max-age=${400 * DAY}`);
    expect(writes.find((w) => w.startsWith(`${ASSIGNMENT_COOKIE}=packed`))).toContain(
      `max-age=${30 * DAY}`,
    );
    expect(store.get(PERSISTENCE_COOKIE)).toBe('p');
    expect(JSON.parse(localStorage.getItem(UUID_COOKIE) as string).value).toBe('v1');
  });

  it('removes the persistent copies again on revoke', () => {
    setConsent('granted');
    const store = new DocumentCookieStore({ secure: false });
    store.set(UUID_COOKIE, 'v1', { maxAgeSec: 400 * DAY });
    syncPersistence(store, 'persistent');

    setConsent('denied');
    const writes = cookieWrites();
    syncPersistence(store, 'session');

    expect(writes.find((w) => w.startsWith(`${UUID_COOKIE}=v1`))).not.toContain('max-age');
    expect(localStorage.getItem(UUID_COOKIE)).toBeNull();
    expect(store.get(UUID_COOKIE)).toBe('v1');
  });
});

describe('a side that was not told defers to the other side', () => {
  it('keeps a server-granted visitor persistent instead of demoting them', () => {
    document.cookie = `${PERSISTENCE_COOKIE}=p; path=/`;
    document.cookie = `${UUID_COOKIE}=v1; path=/`;
    const store = new DocumentCookieStore({ secure: false });
    const writes = cookieWrites();
    const stop = watchConsent(store);
    expect(writes).toEqual([]);
    store.set(UUID_COOKIE, 'v1', { maxAgeSec: 400 * DAY });
    expect(writes[0]).toContain(`max-age=${400 * DAY}`);
    stop();
  });

  it('still lets an explicit denial win over a grant marker', () => {
    document.cookie = `${PERSISTENCE_COOKIE}=p; path=/`;
    setConsent('denied');
    const store = new DocumentCookieStore({ secure: false });
    watchConsent(store)();
    expect(store.get(PERSISTENCE_COOKIE)).toBe('s');
  });
});
