/**
 * The localStorage mirror must not outlive the cookie it mirrors.
 *
 * Found live: the split-URL loop-breaker (`_testa_redirected_<id>`, 15 s) was
 * mirrored to localStorage with no expiry, so once the cookie expired the read
 * fell through to the immortal mirror — a variant visitor was never redirected
 * again on any later visit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseValue, readValue, writeValue } from '../storage.ts';

function wipeCookie(name: string): void {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('localStorage mirror expiry', () => {
  it('a TTL value is gone from every store once its max-age has passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00Z'));
    writeValue('_testa_redirected_15', '2', { maxAgeSec: 15 });
    expect(readValue('_testa_redirected_15')).toBe('2');

    vi.setSystemTime(new Date('2026-11-20T10:00:16Z'));
    wipeCookie('_testa_redirected_15'); // the browser expired the cookie
    expect(readValue('_testa_redirected_15')).toBeNull();
  });

  it('still survives ITP cookie eviction while within its max-age', () => {
    writeValue('_testa_exp', '14.1.0.1', { maxAgeSec: 3600 });
    wipeCookie('_testa_exp');
    expect(readValue('_testa_exp')).toBe('14.1.0.1');
  });

  it('a session value is mirrored to sessionStorage, never localStorage', () => {
    writeValue('_testa_tmp', 'x');
    expect(localStorage.getItem('_testa_tmp')).toBeNull();
    wipeCookie('_testa_tmp');
    expect(readValue('_testa_tmp')).toBe('x');
  });

  it('a Max-Age=0 write clears the mirrors', () => {
    writeValue('_testa_redirected_9', '2', { maxAgeSec: 15 });
    writeValue('_testa_redirected_9', '', { maxAgeSec: 0 });
    expect(readValue('_testa_redirected_9')).toBeNull();
  });

  it('mirrors written by older builds (no expiry stamp) stay readable', () => {
    localStorage.setItem('_testa_exp', '8.0.0.1');
    expect(readValue('_testa_exp')).toBe('8.0.0.1');
  });

  it('eraseValue removes the value and its expiry stamp', () => {
    writeValue('_testa_x', 'y', { maxAgeSec: 60 });
    eraseValue('_testa_x');
    expect(readValue('_testa_x')).toBeNull();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});
