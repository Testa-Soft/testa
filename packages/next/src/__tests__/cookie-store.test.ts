import { ASSIGNMENT_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import { describe, expect, it } from 'vitest';
import { NextCookieStore } from '../cookie-store.ts';
import { reqCookies, resCookies } from './helpers.ts';

describe('NextCookieStore', () => {
  it('reads from request cookies', () => {
    const store = new NextCookieStore(reqCookies({ [UUID_COOKIE]: 'abc' }));
    expect(store.get(UUID_COOKIE)).toBe('abc');
    expect(store.get('missing')).toBeNull();
  });

  it('read-through: a buffered write is visible to a later get', () => {
    const store = new NextCookieStore(reqCookies());
    expect(store.get(ASSIGNMENT_COOKIE)).toBeNull();
    store.set(ASSIGNMENT_COOKIE, '101.2.0.0', { maxAgeSec: 100 });
    expect(store.get(ASSIGNMENT_COOKIE)).toBe('101.2.0.0');
  });

  it('a buffered write shadows the request value', () => {
    const store = new NextCookieStore(reqCookies({ [ASSIGNMENT_COOKIE]: 'old' }));
    store.set(ASSIGNMENT_COOKIE, 'new', { maxAgeSec: 100 });
    expect(store.get(ASSIGNMENT_COOKIE)).toBe('new');
  });

  it('flushes buffered writes onto a response with expected attributes', () => {
    const store = new NextCookieStore(reqCookies(), { secure: true });
    store.set(UUID_COOKIE, 'uuid-1', { maxAgeSec: 3600 });
    const res = resCookies();
    store.applyTo(res);
    const written = res.written.get(UUID_COOKIE);
    expect(written?.value).toBe('uuid-1');
    expect(written?.opts).toMatchObject({
      maxAge: 3600,
      path: '/',
      sameSite: 'lax',
      secure: true,
      httpOnly: false,
    });
  });

  it('respects secure:false for local http dev', () => {
    const store = new NextCookieStore(reqCookies(), { secure: false });
    store.set(UUID_COOKIE, 'x', { maxAgeSec: 10 });
    const res = resCookies();
    store.applyTo(res);
    expect(res.written.get(UUID_COOKIE)?.opts).toMatchObject({ secure: false });
  });

  it('hasWrites reflects pending state', () => {
    const store = new NextCookieStore(reqCookies());
    expect(store.hasWrites()).toBe(false);
    store.set(UUID_COOKIE, 'x', { maxAgeSec: 10 });
    expect(store.hasWrites()).toBe(true);
  });
});
