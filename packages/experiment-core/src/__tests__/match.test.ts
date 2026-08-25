/**
 * URL match semantics — notably `exact` mode's host handling.
 *
 * `exact` compares host + path. The PORT is compared only when the PATTERN
 * names one: two apps on the same hostname but different ports (localhost:3200
 * vs localhost:5002, or staging side-by-sides) are different sites and must
 * never cross-match. A portless pattern — what a dashboard editor authors —
 * matches whatever port the request arrived on, because self-hosted stacks leak
 * internal ports into the URL the app sees. Protocol stays ignored on purpose
 * (http/https unification), as do query params.
 */

import { describe, expect, it } from 'vitest';
import { matchesForMode } from '../redirect/match.ts';

describe('exact match host handling', () => {
  it('matches same host+path across protocols and query params', () => {
    expect(
      matchesForMode('https://acme.com/pricing?utm_source=fb', 'http://acme.com/pricing', 'exact'),
    ).toBe(true);
  });

  it('does NOT match a different port on the same hostname', () => {
    expect(matchesForMode('http://localhost:3200/', 'http://localhost:5002', 'exact')).toBe(false);
    expect(matchesForMode('http://localhost:5002/', 'http://localhost:5002', 'exact')).toBe(true);
  });

  it('default ports normalize (explicit :443 https ≡ implicit)', () => {
    expect(
      matchesForMode('https://acme.com:443/pricing', 'https://acme.com/pricing', 'exact'),
    ).toBe(true);
  });

  it('trailing slash on root still matches a slashless pattern', () => {
    expect(matchesForMode('http://localhost:5002/', 'http://localhost:5002', 'exact')).toBe(true);
  });

  it('a PORTLESS pattern matches whatever port the request arrived on', () => {
    // The self-hosted reality: a mesh or ingress leaks the app's own port into
    // the URL the middleware sees, while the dashboard can only ever hold the
    // public URL. Strict comparison there means nothing matches and nothing
    // explains why — so a pattern that names no port means "this site".
    expect(
      matchesForMode('https://www.acme.com:3000/pricing', 'https://www.acme.com/pricing', 'exact'),
    ).toBe(true);
    expect(
      matchesForMode('http://www.acme.com:8080/pricing', 'https://www.acme.com/pricing', 'exact'),
    ).toBe(true);
  });

  it('still discriminates the hostname when the pattern has no port', () => {
    expect(
      matchesForMode(
        'https://other.acme.com:3000/pricing',
        'https://www.acme.com/pricing',
        'exact',
      ),
    ).toBe(false);
  });

  it('a pattern WITH a port stays strict — two local apps must not cross-match', () => {
    expect(matchesForMode('http://localhost:3200/x', 'http://localhost:5002/x', 'exact')).toBe(
      false,
    );
    expect(matchesForMode('http://localhost:3200/x', 'http://localhost:3200/x', 'exact')).toBe(
      true,
    );
  });

});
