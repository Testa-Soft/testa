import { ASSIGNMENT_COOKIE, UUID_COOKIE } from '@testa-soft/experiment-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';

function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0`;
  }
  // The store mirrors writes into Web Storage (3.3.3 parity), which outlives a
  // cookie by design — so clearing cookies alone leaks values between tests.
  __resetMemoryTier();
  localStorage.clear();
  sessionStorage.clear();
}

describe('DocumentCookieStore', () => {
  afterEach(clearCookies);

  it('round-trips a value through document.cookie', () => {
    const store = new DocumentCookieStore({ secure: false });
    expect(store.get(UUID_COOKIE)).toBeNull();
    store.set(UUID_COOKIE, 'abc-123', { maxAgeSec: 3600 });
    expect(store.get(UUID_COOKIE)).toBe('abc-123');
  });

  it('a later get sees an earlier set (read-through)', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set(ASSIGNMENT_COOKIE, '101.2.0.0', { maxAgeSec: 100 });
    expect(store.get(ASSIGNMENT_COOKIE)).toBe('101.2.0.0');
    store.set(ASSIGNMENT_COOKIE, '101.1.0.0', { maxAgeSec: 100 });
    expect(store.get(ASSIGNMENT_COOKIE)).toBe('101.1.0.0');
  });

  it('encodes + decodes special characters', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_x', 'a b;c=d', { maxAgeSec: 100 });
    expect(store.get('_testa_x')).toBe('a b;c=d');
  });

  it('deletes a cookie when maxAgeSec is 0', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_del', 'v', { maxAgeSec: 100 });
    expect(store.get('_testa_del')).toBe('v');
    store.set('_testa_del', '', { maxAgeSec: 0 });
    expect(store.get('_testa_del')).toBeNull();
  });

  it('returns null for an unrelated cookie name that is a prefix', () => {
    const store = new DocumentCookieStore({ secure: false });
    store.set('_testa_exp_extra', 'v', { maxAgeSec: 100 });
    expect(store.get('_testa_exp')).toBeNull();
  });
});
