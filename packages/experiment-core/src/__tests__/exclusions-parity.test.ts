/**
 * 3.3.3 `handleExclusions` parity — the exact gate chain of crobot's
 * `handleExperiment` (script.js): targeting (first-touch, cached) → excluded
 * gate → page gate → EXCLUSIONS ON EVERY PAGEVIEW (assigned visitors too) →
 * assign → apply. Exclusions never touch the sticky assignment; they suppress
 * apply/redirect for the current pageview only, and `dimension: 'experiment'`
 * makes them a mutual-exclusion primitive with config order = priority.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { ASSIGNMENT_COOKIE } from '../cookie-store.ts';
import { runExperiments } from '../engine.ts';
import { parsePacked } from '../packed-cookie.ts';
import { memoryStore } from './memory-store.ts';

const PAGE = 'https://acme.com/calculator';

/** Two experiments on the same page, mutually excluded via `dimension: 'experiment'`. */
function mutexConfig(): ProjectConfig {
  return {
    project_id: 1,
    slug: 'acme',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '2026-08-04T00:00:00.000Z',
    config_hash: 'hash-mutex',
    experiments: [
      {
        experiment_id: 1,
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'contains', url_pattern: '/calculator' }],
        goals: [],
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          {
            variation_id: 1,
            weight: 100,
            changes: [
              { type: 'redirect', from_url: '/calculator', to_url: 'testa=ab', url_match_type: 'query' },
            ],
          },
        ],
        exclusions: [
          { dimension: 'experiment', operator: 'equals', value: '2' },
          { dimension: 'url', operator: 'contains', value: 'excluded=true' },
        ],
      },
      {
        experiment_id: 2,
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'contains', url_pattern: '/calculator' }],
        goals: [],
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          {
            variation_id: 2,
            weight: 100,
            changes: [{ type: 'change_html', selector: 'h1', content: 'Variation h1' }],
          },
        ],
        exclusions: [{ dimension: 'experiment', operator: 'equals', value: '1' }],
      },
    ],
  };
}

function run(store: ReturnType<typeof memoryStore>, url = PAGE, visitorId = 'v-1') {
  return runExperiments(
    { config: mutexConfig(), currentUrl: url, visitorId, now: 1_755_000_000_000, getCookie: (n) => store.get(n) },
    store,
  );
}

function enrolled(store: ReturnType<typeof memoryStore>, id: number): boolean {
  const state = parsePacked(store.get(ASSIGNMENT_COOKIE)).get(id);
  return state !== undefined && !state.excluded && state.variation >= 0;
}

describe('mutual exclusion (dimension: experiment) — 3.3.3 parity', () => {
  it('a clean visitor is never enrolled in both: earlier config order wins', () => {
    const store = memoryStore();
    run(store);
    expect(enrolled(store, 1)).toBe(true); // exp 1 assigned first (traffic 100)
    expect(enrolled(store, 2)).toBe(false); // exp 2 sees the same-pass assignment
  });

  it('the same-pass assignment is visible through the read-through store', () => {
    const store = memoryStore();
    const result = run(store);
    // exp 1 redirects; exp 2 must not have applied anything.
    expect(result.applied.some((a) => a.experimentId === 2)).toBe(false);
  });

  it('a visitor assigned to BOTH (stale cookies) gets NEITHER applied — 3.3.3 deadlock parity', () => {
    // Packed cookie: exp1→var1, exp2→var2, both fresh (same format the engine writes).
    const store = memoryStore();
    run(store); // enroll exp 1
    // Force an exp-2 assignment on top (simulates cookies from before mutual exclusion existed).
    const packed = store.get(ASSIGNMENT_COOKIE) ?? '';
    store.set(ASSIGNMENT_COOKIE, `${packed}~2.2.0.9999999999`, { maxAgeSec: 1 });

    const result = run(store);
    expect(result.applied).toHaveLength(0);
    expect(result.redirectTo).toBeUndefined();
  });
});

describe('url exclusions re-evaluated on EVERY pageview (assigned visitors too)', () => {
  it('blocks a previously-assigned visitor while the exclusion URL matches', () => {
    const store = memoryStore();
    const first = run(store); // clean visit: enrolls exp 1, redirect fires
    expect(first.redirectTo).toContain('testa=ab');

    const excludedVisit = run(store, `${PAGE}?excluded=true`);
    expect(excludedVisit.redirectTo).toBeUndefined();
    expect(excludedVisit.applied.some((a) => a.experimentId === 1)).toBe(false);
    // Assignment stays sticky — suppression is per-pageview, never a re-roll.
    expect(enrolled(store, 1)).toBe(true);
  });

  it('applies again once the exclusion stops matching', () => {
    const store = memoryStore();
    run(store);
    run(store, `${PAGE}?excluded=true`); // suppressed view
    const back = run(store); // exclusion gone
    expect(back.redirectTo).toContain('testa=ab');
  });
});

describe('targeting default case — any dimension is a query param by name (3.3.3 handleURLParameter)', () => {
  it('targets on an arbitrary query param (gclid), not just utm_*', () => {
    const config = mutexConfig();
    const exp = config.experiments[0];
    if (!exp) throw new Error('fixture has no experiments');
    exp.targeting = [{ dimension: 'gclid', operator: 'equals', value: 'abc123' }];

    const withParam = memoryStore();
    runExperiments(
      { config, currentUrl: `${PAGE}?gclid=abc123`, visitorId: 'v-2', now: 1_755_000_000_000, getCookie: (n) => withParam.get(n) },
      withParam,
    );
    expect(enrolled(withParam, 1)).toBe(true);

    const withoutParam = memoryStore();
    runExperiments(
      { config, currentUrl: PAGE, visitorId: 'v-2', now: 1_755_000_000_000, getCookie: (n) => withoutParam.get(n) },
      withoutParam,
    );
    expect(enrolled(withoutParam, 1)).toBe(false);
  });
});
