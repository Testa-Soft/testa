import type { ProjectConfig, TargetingCondition } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import type { CookieStore } from '../cookie-store.ts';
import { type EngineContext, runExperiments } from '../engine.ts';
import { isSessionLive } from '../session.ts';

const NOW_MS = 1_000_000_000_000; // nowSec = 1_000_000_000
const NOW_SEC = NOW_MS / 1000;
const WINDOW = 30 * 60; // default session length (s)

function mem(seed: Record<string, string> = {}): CookieStore {
  const m = new Map(Object.entries(seed));
  return { get: (n) => m.get(n) ?? null, set: (n, v) => void m.set(n, v) };
}

/** A split-URL experiment on /calculator with the given targeting. */
function cfg(targeting: TargetingCondition[]): ProjectConfig {
  return {
    project_id: 1,
    slug: '1',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'h',
    experiments: [
      {
        experiment_id: 1,
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'contains', url_pattern: '/calculator' }],
        goals: [],
        targeting,
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          {
            variation_id: 1,
            weight: 100,
            changes: [
              {
                type: 'redirect',
                from_url: '/calculator',
                to_url: 'testa=ab',
                url_match_type: 'query',
              },
            ],
          },
        ],
      },
    ],
  };
}

function run(config: ProjectConfig, url: string, store: CookieStore, nowMs = NOW_MS) {
  const ctx: EngineContext = {
    config,
    currentUrl: url,
    visitorId: 'v-1',
    now: nowMs,
    getCookie: (n) => store.get(n),
    debug: true,
  };
  return runExperiments(ctx, store);
}

const GOOGLE: TargetingCondition = {
  dimension: 'utm_source',
  operator: 'contains',
  value: 'google',
};

describe('session-scoped targeting (crobot 3.3.3 parity)', () => {
  it('caches eligibility from the LANDING page so a later UTM-less page still enrolls', () => {
    const store = mem();
    const config = cfg([GOOGLE]);

    // 1. Land on the homepage WITH the UTM (not the experiment page).
    const onHome = run(config, 'https://s.com/?utm_source=google', store);
    expect(onHome.redirectTo).toBeUndefined(); // not the experiment page yet
    expect(store.get('_testa_exp')).toBe(`1.-2.0.${NOW_SEC + WINDOW}`); // eligible sentinel cached

    // 2. Reach /calculator with NO UTM → still enrolled (eligibility was cached).
    const onExp = run(config, 'https://s.com/calculator', store);
    expect(onExp.redirectTo).toBe('https://s.com/calculator?testa=ab');
    expect(isSessionLive(store, 1, NOW_SEC)).toBe(true);
  });

  it('excludes a visitor with no matching UTM, as a flat cooldown (not re-evaluated mid-window)', () => {
    const store = mem();
    const config = cfg([GOOGLE]);

    // Homepage, no UTM → cached exclusion.
    run(config, 'https://s.com/', store);
    expect(store.get('_testa_exp')).toBe(`1.-1.1.${NOW_SEC + WINDOW}`); // excluded, cooldown

    // Reach /calculator WITH the correct UTM, but still inside the cooldown →
    // stays excluded (3.3.3 does not recompute a live exclusion).
    const during = run(
      config,
      'https://s.com/calculator?utm_source=google',
      store,
      NOW_MS + 60_000,
    );
    expect(during.redirectTo).toBeUndefined();
  });

  it('re-evaluates after the cooldown expires and enrolls with the correct UTM', () => {
    const store = mem();
    const config = cfg([GOOGLE]);
    run(config, 'https://s.com/', store); // excluded for 30 min

    // 31 minutes later, on /calculator with the UTM → cooldown expired → recompute → enroll.
    const later = run(
      config,
      'https://s.com/calculator?utm_source=google',
      store,
      NOW_MS + 31 * 60_000,
    );
    expect(later.redirectTo).toBe('https://s.com/calculator?utm_source=google&testa=ab');
  });

  it('grouped targeting: OR within a dimension', () => {
    const store = mem();
    const config = cfg([
      { dimension: 'utm_source', operator: 'contains', value: 'google' },
      { dimension: 'utm_source', operator: 'contains', value: 'bing' },
    ]);
    // Only bing present — passes because same-dimension rules are OR'd. (Query-mode
    // redirect preserves the existing utm param and appends testa=ab.)
    const r = run(config, 'https://s.com/calculator?utm_source=bing', store);
    expect(r.redirectTo).toBe('https://s.com/calculator?utm_source=bing&testa=ab');
  });

  it('grouped targeting: AND across dimensions', () => {
    const config = cfg([
      { dimension: 'utm_source', operator: 'contains', value: 'google' },
      { dimension: 'device', operator: 'equals', value: 'mobile' },
    ]);
    // utm ok but device is desktop (from UA) → excluded (AND fails).
    const store = mem();
    const ctx: EngineContext = {
      config,
      currentUrl: 'https://s.com/calculator?utm_source=google',
      visitorId: 'v-1',
      now: NOW_MS,
      getCookie: (n) => store.get(n),
      userAgent: 'Mozilla/5.0 (Macintosh)', // desktop
    };
    expect(runExperiments(ctx, store).redirectTo).toBeUndefined();
  });

  it('session window expires: isSessionLive flips false past the window', () => {
    const store = mem();
    const config = cfg([GOOGLE]);
    run(config, 'https://s.com/calculator?utm_source=google', store);
    expect(isSessionLive(store, 1, NOW_SEC)).toBe(true);
    expect(isSessionLive(store, 1, NOW_SEC + WINDOW + 1)).toBe(false);
  });
});
