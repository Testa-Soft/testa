import { describe, expect, it } from 'vitest';
import { redirectedName } from '../cookie-store.ts';
import { type RedirectChange, decideRedirect } from '../redirect/decide.ts';
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

  it('respects the redirect dedup marker', () => {
    const store = memoryStore();
    markRedirected(store, 1);
    const d = decideRedirect(
      { experimentId: 1, change: change(), currentUrl: 'https://acme.com/pricing' },
      store,
    );
    expect(d.shouldRedirect).toBe(false);
    expect(d.reason).toBe('already_redirected');
    expect(store.get(redirectedName(1))).toBe('1');
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
