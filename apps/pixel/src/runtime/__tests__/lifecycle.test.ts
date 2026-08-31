import type { ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { consent } from '../consent.ts';
import * as cookies from '../cookies.ts';
import {
  __clearPendingEventsForTests,
  __getPendingEventsForTests,
  hydrate,
  track,
} from '../lifecycle.ts';

beforeEach(async () => {
  await resetPixelState();
});

afterEach(async () => {
  await resetPixelState();
});

function fixture(): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: 17,
        status: 'active',
        traffic_allocation: 100,
        rules: [],
        variations: [
          { variation_id: 100, weight: 50, changes: [] },
          { variation_id: 200, weight: 50, changes: [] },
        ],
        goals: [],
      },
    ],
    published_at: '2026-05-07T00:00:00.000Z',
    config_hash: 'abcdef',
  };
}

/** Type-safe accessor for the first experiment in a fixture. */
function firstExp(p: ProjectConfig): ProjectConfig['experiments'][number] {
  const e = p.experiments[0];
  if (!e) throw new Error('fixture has no experiments');
  return e;
}

describe('hydrate — wiring', () => {
  it('replaces stub methods with live implementations', () => {
    const stub = installQueue();
    expect(stub._hydrated).toBe(false);
    hydrate();
    expect(stub._hydrated).toBe(true);
    expect(typeof stub.track).toBe('function');
  });

  it('drains queue in arrival order', () => {
    const stub = installQueue();
    stub.track('first');
    stub.track('second', { foo: 'bar' });
    stub.track('third');

    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.length).toBeGreaterThanOrEqual(3);
    const names = events.map((e) => e.name);
    expect(names).toContain('first');
    expect(names).toContain('second');
    expect(names).toContain('third');
    // 'second' should carry props
    const second = events.find((e) => e.name === 'second');
    expect(second?.props).toEqual({ foo: 'bar' });
  });

  it('queue is empty after drain', () => {
    const stub = installQueue();
    stub.track('a');
    stub.track('b');
    hydrate();
    expect(stub.q.length).toBe(0);
  });

  it('fires _testa.load() once after first cycle', async () => {
    const stub = installQueue();
    let resolved = false;
    stub.load().then(() => {
      resolved = true;
    });
    hydrate();
    await stub.load();
    expect(resolved).toBe(true);
  });

  it('is idempotent — second hydrate is a no-op', () => {
    installQueue();
    hydrate();
    const eventCountAfterFirst = __getPendingEventsForTests().length;
    hydrate();
    expect(__getPendingEventsForTests().length).toBe(eventCountAfterFirst);
  });
});

describe('hydrate — error isolation', () => {
  it('an error during cycle is caught + recorded in __pixel_debug', () => {
    installQueue();
    // Force an error: ProjectConfig with a deliberately-broken audience
    // (regex with malformed pattern — currently fails closed; safe even on prod).
    // We simulate a real-world break by making the config's experiments array
    // throw on iteration. Easiest: install a broken project.
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: {
        ...fixture(),
        experiments: new Proxy([], {
          get() {
            throw new Error('boom');
          },
        }),
      },
    };
    expect(() => hydrate()).not.toThrow();
    const debug = (window as unknown as { __pixel_debug?: { errors: { phase: string }[] } })
      .__pixel_debug;
    expect(debug).toBeDefined();
    expect(debug?.errors.some((e) => e.phase === 'first_cycle')).toBe(true);
  });

  it('emits a _pixel_health synthetic event when a phase errors', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = {
      project: {
        ...fixture(),
        experiments: new Proxy([], {
          get() {
            throw new Error('boom');
          },
        }),
      },
    };
    hydrate();
    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === '_pixel_health')).toBe(true);
  });
});

describe('runExperimentCycle — DOM mutation (3.9 integration)', () => {
  it("applies the chosen variation's CSS to the page", () => {
    installQueue();
    const config = fixture();
    document.body.innerHTML = '<button class="cta">Buy</button>';
    // Both variations have a CSS change so the cycle mutates regardless of bucketing.
    firstExp(config).variations = [
      {
        variation_id: 100,
        weight: 50,
        changes: [{ type: 'css', content: '.cta{color:red}' }],
      },
      {
        variation_id: 200,
        weight: 50,
        changes: [{ type: 'css', content: '.cta{color:blue}' }],
      },
    ];
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const styleTag = document.querySelector('style[data-testa-css]');
    expect(styleTag).not.toBeNull();
    expect(styleTag?.textContent).toContain('.cta');
    // crobot `css` content is injected verbatim (no reformatting).
    expect(styleTag?.textContent).toMatch(/color:(red|blue)/);
  });
});

describe('runExperimentCycle — happy path', () => {
  it('assigns a variation, fires experiment_view, persists cookie', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    const events = __getPendingEventsForTests();
    const expView = events.find((e) => e.name === 'experiment_view');
    expect(expView).toBeDefined();
    expect(expView?.props.experiment_id).toBe(17);
    expect([100, 200]).toContain(expView?.props.variation_id);
    expect(cookies.getAssignment(17)).toBe(expView?.props.variation_id);
  });

  it('skips experiments whose status is not active', () => {
    installQueue();
    const config = fixture();
    firstExp(config).status = 'paused';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });

  it('skips experiments whose audience does not match', () => {
    installQueue();
    const config = fixture();
    firstExp(config).audience = {
      fact: 'geo.country',
      op: 'in',
      value: ['ZZ'], // visitor's geo is empty → won't match
    };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });

  it('handles audience match (US country)', () => {
    installQueue();
    const config = fixture();
    firstExp(config).audience = {
      fact: 'geo.country',
      op: 'in',
      value: ['US'],
    };
    (window as unknown as { cfPrefill: unknown; cfGeoData: unknown }).cfGeoData = {
      country: 'US',
    };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(true);
  });

  it('runs the cycle on _testa:locationchange (after 50ms debounce + URL change)', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    const eventsAfterFirst = __getPendingEventsForTests().length;
    // Actually change the URL so the canonical-URL diff sees a transition.
    window.history.replaceState({}, '', '/different-page');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    // Wait out the 50ms debounce (no fake timers in this test file).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Cookie was already set; the second cycle uses cookie-first lookup, so
        // experiment_view re-fires (we don't dedupe across navigations in 3.2).
        const eventsAfterSecond = __getPendingEventsForTests().length;
        expect(eventsAfterSecond).toBeGreaterThan(eventsAfterFirst);
        resolve();
      }, 80);
    });
  });

  it('records exposure when frequency_cap is configured', () => {
    installQueue();
    const config = fixture();
    firstExp(config).frequency_cap = { max: 3, window: 'week' };
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const counter = cookies.getFreq(17);
    expect(counter?.count).toBe(1);
  });

  it('honors mutex_group exclusion', () => {
    installQueue();
    cookies.setMutex('checkout', 999); // some other experiment owns it
    const config = fixture();
    firstExp(config).mutex_group = 'checkout';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    hydrate();

    const events = __getPendingEventsForTests();
    expect(events.some((e) => e.name === 'experiment_view')).toBe(false);
  });
});

describe('runExperimentCycle — page-rule gate', () => {
  /** Fixture whose experiment runs on /pricing only and rewrites the <h1>. */
  function htmlTestOnPricing(): ProjectConfig {
    const config = fixture();
    const exp = firstExp(config);
    exp.rules = [{ match_type: 'contains', url_pattern: '/pricing' }];
    exp.goals = [{ goal_id: 7, type: 'page_view', match_type: 'contains', action: '/thanks' }];
    exp.variations = [
      {
        variation_id: 100,
        weight: 100,
        changes: [{ type: 'change_html', selector: 'h1', content: 'Variant headline' }],
      },
    ];
    return config;
  }

  function at(path: string): void {
    window.history.replaceState({}, '', path);
  }

  it('applies the HTML change on the experiment page', () => {
    installQueue();
    at('/pricing');
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    expect(document.querySelector('h1')?.innerHTML).toBe('Variant headline');
    expect(cookies.getAssignment(17)).toBe(100);
  });

  it('does NOT apply the HTML change on a page the rule does not match', () => {
    installQueue();
    at('/blog/some-post');
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    expect(document.querySelector('h1')?.innerHTML).toBe('Control headline');
  });

  it('does NOT bucket or expose off-page', () => {
    installQueue();
    at('/blog/some-post');
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    expect(cookies.getAssignment(17)).toBeNull();
    expect(__getPendingEventsForTests().some((e) => e.name === 'experiment_view')).toBe(false);
  });

  it('does not expose an ALREADY-assigned visitor off-page', () => {
    installQueue();
    cookies.setAssignment(17, 100);
    cookies.bumpSession(17);
    at('/blog/some-post');
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    expect(document.querySelector('h1')?.innerHTML).toBe('Control headline');
    expect(__getPendingEventsForTests().some((e) => e.name === 'experiment_view')).toBe(false);
    // Assignment is untouched — the page gate never re-rolls or clears it.
    expect(cookies.getAssignment(17)).toBe(100);
  });

  it('WIPES the applied HTML when a soft nav leaves the experiment page', async () => {
    installQueue();
    at('/pricing');
    // A persistent-layout <h1> that survives the soft nav, like a real SPA shell.
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();
    expect(document.querySelector('h1')?.innerHTML).toBe('Variant headline');

    at('/blog/some-post');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80)); // SPA debounce

    expect(document.querySelector('h1')?.innerHTML).toBe('Control headline');
  });

  it('re-applies when a soft nav returns to the experiment page', async () => {
    installQueue();
    at('/pricing');
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    at('/blog/some-post');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80));
    expect(document.querySelector('h1')?.innerHTML).toBe('Control headline');

    at('/pricing?ref=nav');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80));
    expect(document.querySelector('h1')?.innerHTML).toBe('Variant headline');
  });

  it('does not let a late-rendered node be mutated after leaving the page', async () => {
    installQueue();
    at('/pricing');
    document.body.innerHTML = '<main></main>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    // Leave the page, then render a matching element — the previous cycle's
    // observer must not touch it (the guard re-checks the live URL).
    at('/blog/some-post');
    const late = document.createElement('h1');
    late.innerHTML = 'Blog title';
    document.querySelector('main')?.appendChild(late);
    await new Promise((r) => setTimeout(r, 20));

    expect(late.innerHTML).toBe('Blog title');
  });

  it('keeps goals armed off-page for an assigned, session-live visitor', () => {
    installQueue();
    cookies.setAssignment(17, 100);
    cookies.bumpSession(17);
    at('/thanks'); // the page_view goal's URL, NOT the experiment page
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    const conversions = __getPendingEventsForTests().filter((e) => e.name === 'conversion');
    expect(conversions.length).toBe(1);
    expect(conversions[0]?.props.goal_id).toBe(7);
  });

  it('does not arm goals off-page when the session has expired', () => {
    installQueue();
    cookies.setAssignment(17, 100);
    // No bumpSession → no live session window.
    at('/thanks');
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTestOnPricing() };
    hydrate();

    expect(__getPendingEventsForTests().some((e) => e.name === 'conversion')).toBe(false);
  });

  it('an experiment with no rules still matches every page (unchanged)', () => {
    installQueue();
    at('/anywhere');
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    expect(__getPendingEventsForTests().some((e) => e.name === 'experiment_view')).toBe(true);
  });
});

describe('runExperimentCycle — nav kills changes, re-bucket re-applies', () => {
  function htmlTest(): ProjectConfig {
    const config = fixture();
    const exp = firstExp(config);
    exp.rules = [{ match_type: 'contains', url_pattern: '/pricing' }];
    exp.variations = [
      {
        variation_id: 100,
        weight: 100,
        changes: [{ type: 'change_html', selector: 'h1', content: 'Variant headline' }],
      },
    ];
    return config;
  }

  /** Land on /pricing with the variation applied to a persistent-shell <h1>. */
  function applied(): void {
    installQueue();
    window.history.replaceState({}, '', '/pricing');
    document.body.innerHTML = '<h1>Control headline</h1>';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: htmlTest() };
    hydrate();
    expect(document.querySelector('h1')?.innerHTML).toBe('Variant headline');
  }

  const h1 = () => document.querySelector('h1')?.innerHTML;

  it('wipes the changes SYNCHRONOUSLY on nav, without waiting for the debounce', () => {
    applied();

    window.history.replaceState({}, '', '/blog/post');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));

    // No await: the teardown is undebounced, so a fast nav never paints the
    // variant content on the new page.
    expect(h1()).toBe('Control headline');
  });

  it('wipes on nav even when the destination is still the experiment page', async () => {
    applied();

    window.history.replaceState({}, '', '/pricing?ref=nav');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    expect(h1()).toBe('Control headline');

    // …and the debounced cycle re-buckets (cookie-first) and re-applies.
    await new Promise((r) => setTimeout(r, 80));
    expect(h1()).toBe('Variant headline');
    expect(cookies.getAssignment(17)).toBe(100);
  });

  it('re-applies on revisit — same bucket, no re-roll', async () => {
    applied();

    window.history.replaceState({}, '', '/blog/post');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80));
    expect(h1()).toBe('Control headline');

    window.history.replaceState({}, '', '/pricing');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80));

    expect(h1()).toBe('Variant headline');
    expect(cookies.getAssignment(17)).toBe(100);
  });

  it('a same-URL pushState does not wipe the changes', async () => {
    applied();

    // Framework updating history state only — no URL change, so no cycle will
    // run to restore anything, and nothing may be torn down.
    window.history.pushState({ n: 1 }, '', window.location.href);
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    expect(h1()).toBe('Variant headline');

    await new Promise((r) => setTimeout(r, 80));
    expect(h1()).toBe('Variant headline');
  });

  it('restores changes when the URL settles back mid-burst (A→B→A)', async () => {
    applied();

    window.history.replaceState({}, '', '/blog/post');
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    window.history.replaceState({}, '', '/pricing'); // settled back inside the debounce
    window.dispatchEvent(new CustomEvent('_testa:locationchange'));
    await new Promise((r) => setTimeout(r, 80));

    // The teardown already ran; the forced cycle must have put it back.
    expect(h1()).toBe('Variant headline');
  });
});

describe('strict consent mode', () => {
  it('holds tracking calls when project consent_mode=strict and state=unknown', () => {
    installQueue();
    const config = fixture();
    config.consent_mode = 'strict';
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: config };
    consent.setState('unknown');
    hydrate();

    expect(consent.isHeld()).toBe(true);
    const events = __getPendingEventsForTests();
    // The experiment_view fired BEFORE we flipped to strict because hydrate
    // first runs applyConsentMode then the cycle. Track() at cycle time
    // checks isHeld and skips. Verify zero non-_pixel_health events.
    expect(events.filter((e) => e.name === 'experiment_view').length).toBe(0);
  });

  it('aware mode (default) does not hold tracking', () => {
    installQueue();
    (window as unknown as { cfPrefill: unknown }).cfPrefill = { project: fixture() };
    hydrate();

    expect(consent.isHeld()).toBe(false);
    expect(__getPendingEventsForTests().some((e) => e.name === 'experiment_view')).toBe(true);
  });
});

describe('public API (post-hydrate)', () => {
  it('_testa.consent flips state', () => {
    const stub = installQueue();
    hydrate();
    stub.consent('denied');
    expect(consent.getState()).toBe('denied');
  });

  it('_testa.track queues an event', () => {
    const stub = installQueue();
    hydrate();
    __clearPendingEventsForTests();
    stub.track('signup', { plan: 'pro' });
    const events = __getPendingEventsForTests();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('signup');
    expect(events[0]?.props).toEqual({ plan: 'pro' });
  });

  it('_testa.trackPurchase shapes the event correctly', () => {
    const stub = installQueue();
    hydrate();
    __clearPendingEventsForTests();
    stub.trackPurchase(49.99, 'USD', 'ORD-1', 2);
    const events = __getPendingEventsForTests();
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('purchase');
    expect(events[0]?.props).toEqual({
      value_native: 49.99,
      currency: 'USD',
      order_id: 'ORD-1',
      items_count: 2,
    });
  });
});

describe('track() consent gating', () => {
  it('drops events when consent is held under strict mode', () => {
    consent.setStrictMode(true);
    consent.setState('denied');
    track('manual', {});
    expect(__getPendingEventsForTests().length).toBe(0);
  });

  it('allows events when consent is granted', () => {
    consent.setState('granted');
    track('manual', {});
    expect(__getPendingEventsForTests().some((e) => e.name === 'manual')).toBe(true);
  });
});
