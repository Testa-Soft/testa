import type { TargetingCondition } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { type TargetingContext, isExcludedByRules, passesTargeting } from '../targeting.ts';

/**
 * v2 rule groups: a condition with `group` belongs to that group. Conditions in
 * a group must ALL match; any one group matching is enough (targeting passes /
 * exclusion fires). Lists without `group` keep the flat 3.3.3 semantics.
 */

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function ctx(
  url: string,
  opts: { ua?: string; country?: string; cookies?: Record<string, string> } = {},
): TargetingContext {
  return {
    url,
    getCookie: (name) => opts.cookies?.[name] ?? null,
    ...(opts.ua ? { userAgent: opts.ua } : {}),
    ...(opts.country ? { country: opts.country } : {}),
  };
}

function cond(
  dimension: string,
  operator: TargetingCondition['operator'],
  value: string,
  group?: number,
): TargetingCondition {
  return { dimension, operator, value, ...(group === undefined ? {} : { group }) };
}

// (mobile AND utm_source contains facebook) OR (country = LT AND utm_campaign contains autumn)
const TARGETING = [
  cond('device', 'equals', 'mobile', 0),
  cond('utm_source', 'contains', 'facebook', 0),
  cond('region_country', 'equals', 'LT', 1),
  cond('utm_campaign', 'contains', 'autumn', 1),
];

describe('grouped targeting (v2)', () => {
  it('passes when every condition of one group matches', () => {
    expect(
      passesTargeting(TARGETING, ctx('https://s.test/?utm_source=facebook', { ua: MOBILE_UA })),
    ).toBe(true);
    expect(
      passesTargeting(
        TARGETING,
        ctx('https://s.test/?utm_campaign=autumn_sale', { ua: DESKTOP_UA, country: 'LT' }),
      ),
    ).toBe(true);
  });

  it('fails when each group only partly matches', () => {
    // mobile without facebook; LT without the campaign
    expect(
      passesTargeting(
        TARGETING,
        ctx('https://s.test/?utm_source=google', { ua: MOBILE_UA, country: 'LT' }),
      ),
    ).toBe(false);
  });

  it('ANDs two values of the same dimension inside a group (country is not A and not B)', () => {
    const notDeNotAt = [
      cond('region_country', 'not_equals', 'DE', 0),
      cond('region_country', 'not_equals', 'AT', 0),
    ];
    expect(passesTargeting(notDeNotAt, ctx('https://s.test/', { country: 'LT' }))).toBe(true);
    expect(passesTargeting(notDeNotAt, ctx('https://s.test/', { country: 'DE' }))).toBe(false);
    expect(passesTargeting(notDeNotAt, ctx('https://s.test/', { country: 'AT' }))).toBe(false);
    // Flat (ungrouped) keeps 3.3.3's OR-within-dimension: ≠DE OR ≠AT is true for DE.
    const flat = notDeNotAt.map(({ group: _g, ...c }) => c);
    expect(passesTargeting(flat, ctx('https://s.test/', { country: 'DE' }))).toBe(true);
  });

  it('a condition it cannot evaluate (no geo signal) fails its group', () => {
    const geoOnly = [cond('region_country', 'equals', 'LT', 0)];
    expect(passesTargeting(geoOnly, ctx('https://s.test/'))).toBe(false);
  });

  it('an ungrouped condition next to groups is a group of its own', () => {
    const mixed = [
      cond('utm_source', 'equals', 'fb', 0),
      cond('utm_medium', 'equals', 'cpc', 0),
      cond('url', 'contains', '/promo'),
    ];
    expect(passesTargeting(mixed, ctx('https://s.test/promo'))).toBe(true);
    expect(passesTargeting(mixed, ctx('https://s.test/?utm_source=fb&utm_medium=cpc'))).toBe(true);
    expect(passesTargeting(mixed, ctx('https://s.test/?utm_source=fb'))).toBe(false);
  });

  it('empty or missing targeting still targets everyone', () => {
    expect(passesTargeting([], ctx('https://s.test/'))).toBe(true);
    expect(passesTargeting(undefined, ctx('https://s.test/'))).toBe(true);
  });
});

describe('grouped exclusions (v2)', () => {
  // exclude (url contains /checkout) OR (cookie staff=1 AND utm_source = internal)
  const EXCLUSIONS = [
    cond('url', 'contains', '/checkout', 0),
    cond('cookie', 'contains', 'staff=1', 1),
    cond('utm_source', 'equals', 'internal', 1),
  ];

  it('excludes when one group fully matches', () => {
    expect(isExcludedByRules(EXCLUSIONS, ctx('https://s.test/checkout'))).toBe(true);
    expect(
      isExcludedByRules(
        EXCLUSIONS,
        ctx('https://s.test/?utm_source=internal', { cookies: { staff: '1' } }),
      ),
    ).toBe(true);
  });

  it('does not exclude on a partial group match', () => {
    expect(isExcludedByRules(EXCLUSIONS, ctx('https://s.test/', { cookies: { staff: '1' } }))).toBe(
      false,
    );
    expect(isExcludedByRules(EXCLUSIONS, ctx('https://s.test/?utm_source=internal'))).toBe(false);
  });

  it('an unevaluable condition never fires its group', () => {
    const geo = [cond('region_country', 'equals', 'LT', 0)];
    expect(isExcludedByRules(geo, ctx('https://s.test/'))).toBe(false);
  });

  it('ungrouped experiment-exclusion rules still fire on their own', () => {
    const rules = [
      cond('utm_source', 'equals', 'a', 0),
      cond('utm_medium', 'equals', 'b', 0),
      cond('url', 'contains', '/x'),
    ];
    expect(isExcludedByRules(rules, ctx('https://s.test/x'))).toBe(true);
    expect(isExcludedByRules(rules, ctx('https://s.test/?utm_source=a'))).toBe(false);
  });

  it('flat exclusions keep the 3.3.3 any-match rule', () => {
    const flat = [cond('utm_source', 'equals', 'a'), cond('utm_medium', 'equals', 'b')];
    expect(isExcludedByRules(flat, ctx('https://s.test/?utm_source=a'))).toBe(true);
  });
});
