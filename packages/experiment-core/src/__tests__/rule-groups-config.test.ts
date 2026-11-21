import {
  type ExperimentConfig,
  type ProjectConfig,
  RULE_GROUPS_EXCLUSION_SENTINEL,
  RULE_GROUPS_TARGETING_SENTINEL,
  type TargetingCondition,
} from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import type { CookieStore } from '../cookie-store.ts';
import { type EngineContext, runExperiments } from '../engine.ts';
import {
  type TargetingContext,
  exclusionsOf,
  isExcludedByRules,
  passesTargeting,
  targetingOf,
} from '../targeting.ts';

/**
 * The served shape of a v2 rule-grouped experiment (collector `buildRules`):
 * the real lists under `targeting_groups` / `exclusion_groups`, sentinels in the
 * legacy `targeting` / `exclusions`.
 *
 *   - New core reads the new keys (targetingOf / exclusionsOf) and never sees
 *     the sentinels.
 *   - An SDK that predates the new keys reads only the legacy fields and
 *     evaluates them FLAT. The flat path below is byte-for-byte the code
 *     published since @testa-soft/experiment-core 1.2.1 (grouping only adds a
 *     branch in front of it), so evaluating the legacy fields through it is
 *     what those SDKs do: never targeted, always excluded.
 */

// Targeting: country is neither DE nor AT (one group), or utm_source=fb.
const TARGETING_GROUPS: TargetingCondition[] = [
  { dimension: 'region_country', operator: 'not_equals', value: 'DE', group: 0 },
  { dimension: 'region_country', operator: 'not_equals', value: 'AT', group: 0 },
  { dimension: 'utm_source', operator: 'equals', value: 'fb', group: 1 },
];
const EXCLUSION_GROUPS: TargetingCondition[] = [
  { dimension: 'url', operator: 'contains', value: '/checkout', group: 0 },
  { dimension: 'utm_medium', operator: 'equals', value: 'email', group: 0 },
];

const SERVED: ExperimentConfig = {
  experiment_id: 7,
  status: 'active',
  traffic_allocation: 100,
  rules: [{ match_type: 'contains', url_pattern: '/' }],
  goals: [],
  variations: [
    { variation_id: 0, weight: 0, changes: [] },
    { variation_id: 1, weight: 100, changes: [{ type: 'css', content: 'body{}' }] },
  ],
  platform_version: 'v2',
  targeting: [{ ...RULE_GROUPS_TARGETING_SENTINEL }],
  exclusions: [{ ...RULE_GROUPS_EXCLUSION_SENTINEL }],
  targeting_groups: TARGETING_GROUPS,
  exclusion_groups: EXCLUSION_GROUPS,
};

function ctx(
  url: string,
  country?: string,
  cookies: Record<string, string> = {},
): TargetingContext {
  return {
    url,
    getCookie: (n) => cookies[n] ?? null,
    userAgent: 'Mozilla/5.0 (iPhone) Mobile',
    ...(country ? { country } : {}),
  };
}

// Every visitor shape worth checking, including ones that try to satisfy the
// sentinel's dimension by URL parameter.
const VISITORS: TargetingContext[] = [
  ctx('https://s.test/', 'LT'),
  ctx('https://s.test/', 'DE'),
  ctx('https://s.test/?utm_source=fb', 'DE'),
  ctx('https://s.test/checkout?utm_medium=email', 'LT'),
  ctx('https://s.test/'),
  ctx('https://s.test/?testa_rule_groups_required=1', 'LT'),
  ctx('https://s.test/?testa_rule_groups_required=(?!)testa_rule_groups_required', 'LT'),
  ctx('not a url'),
];

describe('targetingOf / exclusionsOf', () => {
  it('prefer the rule-group keys over the legacy fields', () => {
    expect(targetingOf(SERVED)).toBe(TARGETING_GROUPS);
    expect(exclusionsOf(SERVED)).toBe(EXCLUSION_GROUPS);
  });

  it('fall back to the legacy fields for flat experiments', () => {
    const flat = [{ dimension: 'device', operator: 'equals', value: 'mobile' } as const];
    expect(targetingOf({ targeting: flat })).toBe(flat);
    expect(exclusionsOf({ exclusions: flat })).toBe(flat);
    expect(targetingOf({})).toBeUndefined();
  });

  it('an empty rule-group list means "no rules", not "fall back to the sentinel"', () => {
    const exp = { ...SERVED, exclusion_groups: [] };
    expect(exclusionsOf(exp)).toEqual([]);
    expect(isExcludedByRules(exclusionsOf(exp), ctx('https://s.test/'))).toBe(false);
  });
});

describe('new core evaluates the groups', () => {
  it('targets by group', () => {
    expect(passesTargeting(targetingOf(SERVED), ctx('https://s.test/', 'LT'))).toBe(true);
    expect(passesTargeting(targetingOf(SERVED), ctx('https://s.test/', 'DE'))).toBe(false);
    expect(passesTargeting(targetingOf(SERVED), ctx('https://s.test/?utm_source=fb', 'DE'))).toBe(
      true,
    );
  });

  it('excludes by group', () => {
    expect(
      isExcludedByRules(exclusionsOf(SERVED), ctx('https://s.test/checkout?utm_medium=email')),
    ).toBe(true);
    expect(isExcludedByRules(exclusionsOf(SERVED), ctx('https://s.test/checkout'))).toBe(false);
  });

  it('the engine enrolls through the groups, ignoring the sentinels', () => {
    const freshStore = (): CookieStore => {
      const m = new Map<string, string>();
      return { get: (n) => m.get(n) ?? null, set: (n, v) => void m.set(n, v) };
    };
    const config: ProjectConfig = {
      project_id: 1,
      slug: '1',
      integration_version: '4.0',
      consent_mode: 'aware',
      published_at: '',
      config_hash: 'h',
      experiments: [SERVED],
    };
    // A fresh visitor (cookie jar) per run: an assigned visitor skips targeting.
    const run = (country: string, store = freshStore()) =>
      runExperiments(
        {
          config,
          currentUrl: 'https://s.test/',
          visitorId: `v-${country}`,
          now: 1_000_000_000_000,
          getCookie: (n) => store.get(n),
          country,
        } satisfies EngineContext,
        store,
      );
    expect(run('LT').applied.map((a) => a.variationId)).toEqual([1]);
    expect(run('DE').applied).toEqual([]);
  });
});

describe('older SDKs (flat evaluation of the legacy fields) fail closed', () => {
  it('never target anyone', () => {
    for (const visitor of VISITORS) {
      expect(passesTargeting(SERVED.targeting, visitor)).toBe(false);
    }
  });

  it('exclude everyone, so an already-assigned visitor is not served either', () => {
    for (const visitor of VISITORS) {
      expect(isExcludedByRules(SERVED.exclusions, visitor)).toBe(true);
    }
  });

  it('the sentinels carry no group, so the flat path is what evaluates them', () => {
    expect(SERVED.targeting?.some((c) => c.group !== undefined)).toBe(false);
    expect(SERVED.exclusions?.some((c) => c.group !== undefined)).toBe(false);
  });
});
