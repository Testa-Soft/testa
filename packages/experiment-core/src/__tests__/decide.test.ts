import { describe, expect, it } from 'vitest';
import { redirectedName } from '../cookie-store.ts';
import {
  type RedirectChange,
  decideRedirect,
  resolveRedirectDestination,
} from '../redirect/decide.ts';
import { markRedirected } from '../redirect/dedup.ts';
import { memoryStore } from './memory-store.ts';

const change = (over: Partial<RedirectChange> = {}): RedirectChange => ({
  type: 'redirect',
  from_url: 'https://acme.com/pricing',
  to_url: 'https://acme.com/pricing-v2',
  ...over,
});

describe('decideRedirect', () => {
  it('fires on an exact match and merges current query params', () => {
    const d = decideRedirect(
      { experimentId: 1, change: change(), currentUrl: 'https://acme.com/pricing?utm_source=fb' },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(true);
    expect(d.finalUrl).toContain('/pricing-v2');
    expect(d.finalUrl).toContain('utm_source=fb');
  });

  it('does not fire when the current URL does not match from_url', () => {
    const d = decideRedirect(
      { experimentId: 1, change: change(), currentUrl: 'https://acme.com/home' },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(false);
    expect(d.reason).toBe('no_match');
  });

  it('redirects even when a dedup marker is set — a variant visitor on the control URL is ALWAYS redirected', () => {
    const store = memoryStore();
    markRedirected(store, 1); // legacy/pixel marker present — must not block
    const d = decideRedirect(
      { experimentId: 1, change: change(), currentUrl: 'https://acme.com/pricing' },
      store,
    );
    expect(d.shouldRedirect).toBe(true);
    expect(d.reason).toBe('match');
  });

  it('exact mode: redirects when to_url differs from the current URL only by a query param', () => {
    // crobot setup: /calculator (exact) → /calculator?testa=aa. Exact matching
    // ignores query params on the FROM side, but that must not make the
    // destination unreachable.
    const c = change({
      from_url: 'https://acme.com/calculator',
      to_url: 'https://acme.com/calculator?testa=aa',
      url_match_type: 'exact',
    });
    const d = decideRedirect(
      { experimentId: 1, change: c, currentUrl: 'https://acme.com/calculator' },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(true);
    expect(d.finalUrl).toBe('https://acme.com/calculator?testa=aa');

    // With current query params: merged cleanly (3.3.3 mergeParams — one '?').
    const withUtm = decideRedirect(
      {
        experimentId: 1,
        change: c,
        currentUrl: 'https://acme.com/calculator?utm_source=facebook',
      },
      memoryStore(),
    );
    expect(withUtm.shouldRedirect).toBe(true);
    expect(withUtm.finalUrl).toBe('https://acme.com/calculator?testa=aa&utm_source=facebook');

    // Loop safety intact: already on the destination → no-op.
    const atDest = decideRedirect(
      {
        experimentId: 1,
        change: c,
        currentUrl: 'https://acme.com/calculator?testa=aa&utm_source=facebook',
      },
      memoryStore(),
    );
    expect(atDest.shouldRedirect).toBe(false);
    expect(atDest.reason).toBe('skipped_same_url');
  });

  it('resolveRedirectDestination: exact mode reaches a query-only-different to_url (engine path)', () => {
    const c = change({
      from_url: 'https://acme.com/calculator',
      to_url: 'https://acme.com/calculator?testa=aa',
      url_match_type: 'exact',
    });
    const d = resolveRedirectDestination(c, 'https://acme.com/calculator');
    expect(d.shouldRedirect).toBe(true);
    expect(d.finalUrl).toBe('https://acme.com/calculator?testa=aa');

    const atDest = resolveRedirectDestination(c, 'https://acme.com/calculator?testa=aa');
    expect(atDest.shouldRedirect).toBe(false);
    expect(atDest.reason).toBe('skipped_same_url');
  });

  it('exact mode with a RELATIVE to_url (crobot-native) redirects once and terminates', () => {
    // crobot sends path-relative URLs: from '/calculator' to '/calculator?testa=aa'.
    // The at-destination equality must absolutize the relative destination
    // against the current URL — otherwise it never tests equal and loops.
    const c = change({
      from_url: '/calculator',
      to_url: '/calculator?testa=aa',
      url_match_type: 'exact',
    });

    const hop = resolveRedirectDestination(c, 'http://localhost:3200/calculator');
    expect(hop.shouldRedirect).toBe(true);

    const atDest = resolveRedirectDestination(c, 'http://localhost:3200/calculator?testa=aa');
    expect(atDest.shouldRedirect).toBe(false);
    expect(atDest.reason).toBe('skipped_same_url');

    // decideRedirect (pixel path) also must not loop; it stops at the from-match
    // (a relative from_url doesn't exact-match an absolute URL) — either reason
    // is a safe non-redirect.
    const viaDecide = decideRedirect(
      { experimentId: 1, change: c, currentUrl: 'http://localhost:3200/calculator?testa=aa' },
      memoryStore(),
    );
    expect(viaDecide.shouldRedirect).toBe(false);
  });

  it('is a no-op when the destination canonicalizes to the current URL', () => {
    const d = decideRedirect(
      {
        experimentId: 1,
        change: change({ to_url: 'https://acme.com/pricing' }),
        currentUrl: 'https://acme.com/pricing',
      },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(false);
    expect(d.reason).toBe('skipped_same_url');
  });

  it('aborts on a missing target', () => {
    const d = decideRedirect(
      { experimentId: 1, change: change({ to_url: '' }), currentUrl: 'https://acme.com/pricing' },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(false);
    expect(d.reason).toBe('aborted_invalid_target');
  });

  it('does NOT write the dedup marker itself (caller commits)', () => {
    const store = memoryStore();
    decideRedirect(
      { experimentId: 1, change: change(), currentUrl: 'https://acme.com/pricing' },
      store,
    );
    expect(store.get(redirectedName(1))).toBeNull();
  });

  it('exact match ignores query params (pixel parity)', () => {
    // Current URL carries utm params the from_url pattern does not mention.
    const d = decideRedirect(
      {
        experimentId: 1,
        change: change(),
        currentUrl: 'https://acme.com/pricing?utm_source=facebook&gclid=x',
      },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(true);
    // Current params flow to the destination.
    expect(d.finalUrl).toContain('utm_source=facebook');
  });

  it('skips when the visitor is already on the destination (sticky, no lockout)', () => {
    // Broad contains from_url that also matches the variant URL — must NOT loop.
    const d = decideRedirect(
      {
        experimentId: 1,
        change: change({ from_url: '/pricing', to_url: '/pricing-v2', url_match_type: 'contains' }),
        currentUrl: 'https://acme.com/pricing-v2',
      },
      memoryStore(),
    );
    expect(d.shouldRedirect).toBe(false);
    expect(d.reason).toBe('skipped_same_url');
  });

  it('still redirects a visitor sitting on control (no once-ever lockout)', () => {
    const change2 = change({
      from_url: '/pricing',
      to_url: '/pricing-v2',
      url_match_type: 'contains',
    });
    const store = memoryStore();
    const a = decideRedirect(
      { experimentId: 1, change: change2, currentUrl: 'https://acme.com/pricing' },
      store,
    );
    const b = decideRedirect(
      { experimentId: 1, change: change2, currentUrl: 'https://acme.com/pricing' },
      store,
    );
    expect(a.shouldRedirect).toBe(true);
    expect(b.shouldRedirect).toBe(true);
  });
});
