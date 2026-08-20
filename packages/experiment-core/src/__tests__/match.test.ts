/**
 * URL match semantics — notably `exact` mode's host handling.
 *
 * `exact` compares host + path. HOST includes the PORT: two apps on the same
 * hostname but different ports (localhost:3200 vs localhost:5002, or staging
 * side-by-sides) are different sites and must never cross-match. Protocol
 * stays ignored on purpose (http/https unification), as do query params.
 */

import { describe, expect, it } from 'vitest';
import { matchesForMode } from '../redirect/match.ts';

describe('exact match host handling', () => {
  it('matches same host+path across protocols and query params', () => {
    expect(matchesForMode('https://acme.com/pricing?utm_source=fb', 'http://acme.com/pricing', 'exact')).toBe(true);
  });

  it('does NOT match a different port on the same hostname', () => {
    expect(matchesForMode('http://localhost:3200/', 'http://localhost:5002', 'exact')).toBe(false);
    expect(matchesForMode('http://localhost:5002/', 'http://localhost:5002', 'exact')).toBe(true);
  });

  it('default ports normalize (explicit :443 https ≡ implicit)', () => {
    expect(matchesForMode('https://acme.com:443/pricing', 'https://acme.com/pricing', 'exact')).toBe(true);
  });

  it('trailing slash on root still matches a slashless pattern', () => {
    expect(matchesForMode('http://localhost:5002/', 'http://localhost:5002', 'exact')).toBe(true);
  });
});
