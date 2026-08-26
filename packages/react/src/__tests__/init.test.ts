import { onVariationAssigned } from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE, UUID_COOKIE, markRedirected } from '@testa-soft/experiment-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTesta } from '../init.ts';
import { domConfig, memoryStore, setWindowUrl, splitUrlConfig } from './helpers.ts';

const AT_PAGE = 'https://acme.com/pricing';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('initTesta — visitor id', () => {
  it('mints a _testa_uuid when absent', async () => {
    const store = memoryStore();
    await initTesta({
      config: splitUrlConfig(),
      currentUrl: 'https://acme.com/home',
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(store.get(UUID_COOKIE)).toBeTruthy();
  });

  it('keeps an existing visitor id', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'keep-me' });
    await initTesta({
      config: splitUrlConfig(),
      currentUrl: 'https://acme.com/home',
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(store.get(UUID_COOKIE)).toBe('keep-me');
  });
});

describe('initTesta — DOM apply', () => {
  it('applies the assigned variant DOM changes given a cookie', async () => {
    setWindowUrl(AT_PAGE); // the apply guard reads the LIVE location
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const res = await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(res.redirected).toBe(false);
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
    expect(res.teardowns.length).toBeGreaterThan(0);
  });
});

describe('initTesta — client redirect', () => {
  it('navigates to the destination and marks the redirect guard', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    const navigate = vi.fn();
    const res = await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0]?.[0]).toContain('/pricing-v2');
    expect(res.redirected).toBe(true);
  });

  it('redirects on EVERY visit to the control URL — sticky, no lockout, marker ignored', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v', [ASSIGNMENT_COOKIE]: '101.2.0.0' });
    markRedirected(store, 101); // stale marker (legacy builds / pixel) must not block
    const navigate = vi.fn();
    const opts = {
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    };
    const first = await initTesta(opts);
    const second = await initTesta(opts); // e.g. soft-nav back to the control URL
    expect(first.redirected).toBe(true);
    expect(second.redirected).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});

describe('initTesta — preview mode', () => {
  it('fetches + applies draft changes, skipping assignment', async () => {
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const store = memoryStore({ [UUID_COOKIE]: 'v' });
    const changes = [{ type: 'change_html', selector: '#hero', content: 'DRAFT' }];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ changes }), { status: 200 })) as unknown as typeof fetch;
    const res = await initTesta({
      config: splitUrlConfig(),
      currentUrl: `${AT_PAGE}?testa_preview=true&testa_preview_token=tok`,
      store,
      previewApiUrl: 'https://app.testa-soft.tech',
      tracking: false,
      navigate: () => undefined,
      fetchImpl,
    });
    expect(res.applied).toHaveLength(0);
    expect(document.querySelector('#hero')?.innerHTML).toBe('DRAFT');
    // No assignment cookie written in preview mode.
    expect(store.get(ASSIGNMENT_COOKIE)).toBeNull();
  });
});

describe('initTesta — exposure tracking', () => {
  it('emits one exposure per fresh enrollment when tracking is on', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'fresh-visitor' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      trackingHost: 'https://track.example.com',
      navigate: () => undefined,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://track.example.com/api/leads');
  });

  it('does not emit when tracking is off', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'fresh-visitor' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await initTesta({
      config: domConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate: () => undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('initTesta — geo targeting via config.geo', () => {
  /** Split-URL config gated on `region_country = LT`, variant 2 (redirect) forced. */
  const geoTargetedConfig = (geo?: { country: string; region: string; city: string }) => {
    const config = splitUrlConfig();
    const experiment = config.experiments[0];
    if (!experiment) throw new Error('fixture config has no experiments');
    return {
      ...config,
      ...(geo ? { geo } : {}),
      experiments: [
        {
          ...experiment,
          targeting: [{ dimension: 'region_country', operator: 'exact' as const, value: 'LT' }],
          variations: [
            { variation_id: 1, weight: 0, changes: [] },
            {
              variation_id: 2,
              weight: 100,
              changes: [
                {
                  type: 'redirect' as const,
                  from_url: AT_PAGE,
                  to_url: 'https://acme.com/pricing-v2',
                },
              ],
            },
          ],
        },
      ],
    };
  };

  it('enters the experiment when config.geo.country matches the targeting rule', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v' });
    const navigate = vi.fn();
    const res = await initTesta({
      config: geoTargetedConfig({ country: 'LT', region: 'VL', city: 'Vilnius' }),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(res.redirected).toBe(true);
  });

  it('stays out when config.geo.country does not match', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v' });
    const navigate = vi.fn();
    const res = await initTesta({
      config: geoTargetedConfig({ country: 'US', region: 'CA', city: 'San Francisco' }),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(res.redirected).toBe(false);
  });

  it('fails closed when config.geo is absent (dimension unsupported)', async () => {
    const store = memoryStore({ [UUID_COOKIE]: 'v' });
    const navigate = vi.fn();
    const res = await initTesta({
      config: geoTargetedConfig(),
      currentUrl: AT_PAGE,
      store,
      tracking: false,
      navigate,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(res.redirected).toBe(false);
  });
});

describe('initTesta — geo gates apply to ALL experiment types, both directions', () => {
  const LT_GEO = { country: 'LT', region: 'VL', city: 'Vilnius' };

  it('geo targeting gates a DOM experiment (match → changes applied)', async () => {
    setWindowUrl(AT_PAGE);
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const config = { ...domConfig(), geo: LT_GEO };
    const experiment = config.experiments[0];
    if (experiment) {
      experiment.targeting = [{ dimension: 'region_country', operator: 'exact', value: 'LT' }];
    }
    await initTesta({
      config,
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v' }),
      tracking: false,
      navigate: () => undefined,
    });
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
  });

  it('geo targeting gates a DOM experiment (mismatch → control untouched)', async () => {
    setWindowUrl(AT_PAGE);
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const config = { ...domConfig(), geo: { country: 'US', region: 'CA', city: 'SF' } };
    const experiment = config.experiments[0];
    if (experiment) {
      experiment.targeting = [{ dimension: 'region_country', operator: 'exact', value: 'LT' }];
    }
    await initTesta({
      config,
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v' }),
      tracking: false,
      navigate: () => undefined,
    });
    expect(document.querySelector('#hero')?.innerHTML).toBe('CONTROL');
  });

  it('geo EXCLUSION keeps a matching visitor out of a DOM experiment', async () => {
    setWindowUrl(AT_PAGE);
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const config = { ...domConfig(), geo: LT_GEO };
    const experiment = config.experiments[0];
    if (experiment) {
      experiment.exclusions = [{ dimension: 'region_country', operator: 'exact', value: 'LT' }];
    }
    await initTesta({
      config,
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v' }),
      tracking: false,
      navigate: () => undefined,
    });
    expect(document.querySelector('#hero')?.innerHTML).toBe('CONTROL');
  });

  it('geo EXCLUSION with no geo signal fails open (visitor enters)', async () => {
    setWindowUrl(AT_PAGE);
    document.body.innerHTML = '<div id="hero">CONTROL</div>';
    const config = domConfig(); // no geo in config
    const experiment = config.experiments[0];
    if (experiment) {
      experiment.exclusions = [{ dimension: 'region_country', operator: 'exact', value: 'LT' }];
    }
    await initTesta({
      config,
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v' }),
      tracking: false,
      navigate: () => undefined,
    });
    expect(document.querySelector('#hero')?.innerHTML).toBe('VARIANT');
  });
});

describe('initTesta — variation_assigned', () => {
  it('fires BEFORE the redirect, while the page is still alive', async () => {
    // The event a listener uses to send its own tracking. `variation_applied`
    // is no use here: a split-URL visitor is already navigating away by then.
    const order: string[] = [];
    const off = onVariationAssigned((event) => {
      order.push(`assigned:${event.experiment}:${event.variation}`);
    });
    setWindowUrl(AT_PAGE);

    await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v1', [ASSIGNMENT_COOKIE]: '101.2.0.0' }),
      tracking: false,
      navigate: () => order.push('navigate'),
    });

    off();
    expect(order).toEqual(['assigned:101:2', 'navigate']);
  });

  it('fires for a control visitor too (no redirect)', async () => {
    // Filtered by visitor: the bus replays its history to every new handler, so
    // events from earlier tests in this file arrive here too.
    const seen: number[] = [];
    const off = onVariationAssigned((event) => {
      if (event.uuid === 'v2') seen.push(event.variation);
    });
    setWindowUrl(AT_PAGE);

    await initTesta({
      config: splitUrlConfig(),
      currentUrl: AT_PAGE,
      store: memoryStore({ [UUID_COOKIE]: 'v2', [ASSIGNMENT_COOKIE]: '101.1.0.0' }),
      tracking: false,
      navigate: () => undefined,
    });

    off();
    expect(seen).toEqual([1]);
  });
});
