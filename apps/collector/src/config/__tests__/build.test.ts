import { describe, expect, it } from 'bun:test';
import {
  RULE_GROUPS_EXCLUSION_SENTINEL,
  RULE_GROUPS_TARGETING_SENTINEL,
} from '@testa-platform/shared-types';
import { loadPixelUrlMatch } from '../../__test-utils__/pixel-url-match.ts';
import { type TestaConfigOptions, buildTestaConfig } from '../build.ts';

type Warn = NonNullable<TestaConfigOptions['warn']>;

// A trimmed copy of the real `GET /projects/12345.json` payload.
const baseExp = {
  id: 531,
  url_match_type: 'exact',
  identifier: 339593,
  title: 'Pricing DEMO',
  traffic: 100,
  url: 'http://localhost:3100/pricing',
  type: 'split_url',
  status: 'active',
  variations: [
    { id: 1563, identifier: 0, traffic: 50, url_match_type: 'contains', changes: [] },
    {
      id: 1564,
      identifier: 1,
      traffic: 50,
      url_match_type: 'exact',
      changes: [{ url_match_type: 'exact', content: 'http://localhost:3100/pricing-v2' }],
    },
  ],
};

const sourceProject = { id: 2, name: 'Test', experiments: [baseExp] };

describe('buildTestaConfig', () => {
  it('maps platform_version v1 / v2 through; anything else is left absent (= v1)', () => {
    const versions = ['v2', 'v1', 'V2', 'v3', null, undefined];
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: versions.map((platform_version, i) => ({
        ...baseExp,
        identifier: 1000 + i,
        ...(platform_version === undefined ? {} : { platform_version }),
      })),
    });
    expect(cfg.experiments.map((e) => e.platform_version)).toEqual([
      'v2',
      'v1',
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(cfg.experiments.slice(2).every((e) => !('platform_version' in e))).toBe(true);
  });

  describe('v2 rule groups', () => {
    const grouped = {
      targeting: [
        { type: 'region_country', operator: 'not_equals', value: 'DE', group: 0 },
        { type: 'region_country', operator: 'not_equals', value: 'AT', group: 0 },
        { type: 'utm_source', operator: 'contains', value: 'fb', group: 1 },
      ],
      exclusions: [
        { type: 'url', operator: 'contains', value: '/checkout', group: 0 },
        { type: 'experiment', operator: 'equals', value: '12', group: null },
      ],
    };
    const build = (exps: Record<string, unknown>[], warn: Warn = () => {}) =>
      buildTestaConfig(
        {
          ...sourceProject,
          experiments: exps.map((e, i) => ({ ...baseExp, identifier: 1 + i, ...e })),
        },
        { warn },
      ).experiments;

    it('ships grouped lists under the new keys and sentinels in the legacy fields', () => {
      const [v2] = build([{ platform_version: 'v2', ...grouped }]);
      expect(v2?.targeting).toEqual([RULE_GROUPS_TARGETING_SENTINEL]);
      expect(v2?.exclusions).toEqual([RULE_GROUPS_EXCLUSION_SENTINEL]);
      expect(v2?.targeting_groups).toEqual([
        { dimension: 'region_country', operator: 'not_equals', value: 'DE', group: 0 },
        { dimension: 'region_country', operator: 'not_equals', value: 'AT', group: 0 },
        { dimension: 'utm_source', operator: 'contains', value: 'fb', group: 1 },
      ]);
      expect(v2?.exclusion_groups).toEqual([
        { dimension: 'url', operator: 'contains', value: '/checkout', group: 0 },
        { dimension: 'experiment', operator: 'equals', value: '12' },
      ]);
    });

    it('a group on either list alone moves both lists (the other may be flat or empty)', () => {
      const [onlyTargeting, onlyExclusions] = build([
        { platform_version: 'v2', targeting: grouped.targeting },
        { platform_version: 'v2', exclusions: grouped.exclusions, targeting: [] },
      ]);
      expect(onlyTargeting?.targeting).toEqual([RULE_GROUPS_TARGETING_SENTINEL]);
      expect(onlyTargeting?.exclusion_groups).toEqual([]);
      expect(onlyExclusions?.targeting).toEqual([RULE_GROUPS_TARGETING_SENTINEL]);
      expect(onlyExclusions?.targeting_groups).toEqual([]);
      expect(onlyExclusions?.exclusion_groups?.[0]?.group).toBe(0);
    });

    it('keeps an ungrouped v2 experiment flat, on the legacy fields only', () => {
      const [v2] = build([
        {
          platform_version: 'v2',
          targeting: [{ type: 'device', operator: 'equals', value: 'mobile', group: null }],
        },
      ]);
      expect(v2?.targeting).toEqual([{ dimension: 'device', operator: 'equals', value: 'mobile' }]);
      expect(v2 && 'targeting_groups' in v2).toBe(false);
      expect(v2 && 'exclusion_groups' in v2).toBe(false);
    });

    it('never ships groups for v1 (or unversioned) experiments', () => {
      for (const exp of build([{ platform_version: 'v1', ...grouped }, { ...grouped }])) {
        expect(exp.targeting?.some((c) => 'group' in c)).toBe(false);
        expect(exp.exclusions?.some((c) => 'group' in c)).toBe(false);
        expect('targeting_groups' in exp).toBe(false);
        expect(exp.targeting?.[0]?.dimension).toBe('region_country');
      }
    });

    it('drops a malformed group with a warning, keeping the rule as its own group', () => {
      const warnings: unknown[] = [];
      const [v2] = build(
        [
          {
            platform_version: 'v2',
            targeting: [
              { type: 'device', operator: 'equals', value: 'mobile', group: 0 },
              { type: 'utm_source', operator: 'equals', value: 'a', group: -1 },
              { type: 'utm_source', operator: 'equals', value: 'b', group: '2' },
              { type: 'utm_source', operator: 'equals', value: 'c', group: 1.5 },
              { type: 'utm_source', operator: 'equals', value: 'd', group: null },
            ],
          },
        ],
        (_m, detail) => {
          warnings.push(detail);
        },
      );
      expect(v2?.targeting_groups?.map((c) => c.group)).toEqual([
        0,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(warnings).toEqual([
        { experiment: 1, dimension: 'utm_source', group: -1 },
        { experiment: 1, dimension: 'utm_source', group: '2' },
        { experiment: 1, dimension: 'utm_source', group: 1.5 },
      ]);
    });

    it('an experiment whose only groups are malformed stays flat', () => {
      const [v2] = build([
        {
          platform_version: 'v2',
          targeting: [{ type: 'device', operator: 'equals', value: 'mobile', group: -3 }],
        },
      ]);
      expect(v2?.targeting).toEqual([{ dimension: 'device', operator: 'equals', value: 'mobile' }]);
      expect(v2 && 'targeting_groups' in v2).toBe(false);
    });
  });

  it('maps a split_url experiment to ProjectConfig', () => {
    const cfg = buildTestaConfig(sourceProject, { slug: '12345' });
    expect(cfg.slug).toBe('12345');
    expect(cfg.project_id).toBe(2);
    expect(cfg.experiments).toHaveLength(1);

    const exp = cfg.experiments[0];
    expect(exp?.experiment_id).toBe(339593);
    expect(exp?.status).toBe('active');
    expect(exp?.traffic_allocation).toBe(100);
    expect(exp?.rules?.[0]).toEqual({
      match_type: 'exact',
      url_pattern: 'http://localhost:3100/pricing',
    });
  });

  it('assembles the redirect from experiment url + variant change content', () => {
    const cfg = buildTestaConfig(sourceProject);
    const variant = cfg.experiments[0]?.variations.find((v) => v.variation_id === 1);
    expect(variant?.weight).toBe(50);
    expect(variant?.changes[0]).toEqual({
      type: 'redirect',
      from_url: 'http://localhost:3100/pricing',
      to_url: 'http://localhost:3100/pricing-v2',
      url_match_type: 'exact',
    });
  });

  it('gives the control variation (identifier 0) no changes', () => {
    const cfg = buildTestaConfig(sourceProject);
    const control = cfg.experiments[0]?.variations.find((v) => v.variation_id === 0);
    expect(control?.changes).toEqual([]);
  });

  it('maps inactive → paused', () => {
    const paused = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, status: 'inactive' }],
    });
    expect(paused.experiments[0]?.status).toBe('paused');
  });

  it('maps a `copy` (HTML/DOM) experiment’s crobot-native changes through', () => {
    const copyExp = {
      ...baseExp,
      type: 'copy',
      url_match_type: 'site_wide',
      variations: [
        { id: 1, identifier: 0, traffic: 0, changes: [] },
        {
          id: 2,
          identifier: 1,
          traffic: 100,
          changes: [
            { type: 'change_html', selector: '#hero', content: 'New heading' },
            { type: 'css', content: '#hero{color:red}' },
            { type: 'hide_element', selector: '.promo' },
          ],
        },
      ],
    };
    const cfg = buildTestaConfig({ ...sourceProject, experiments: [copyExp] });
    expect(cfg.experiments).toHaveLength(1);
    const variant = cfg.experiments[0]?.variations.find((v) => v.variation_id === 1);
    expect(variant?.changes).toEqual([
      { type: 'change_html', selector: '#hero', content: 'New heading' },
      { type: 'css', content: '#hero{color:red}' },
      { type: 'hide_element', selector: '.promo' },
    ]);
    const control = cfg.experiments[0]?.variations.find((v) => v.variation_id === 0);
    expect(control?.changes).toEqual([]);
  });

  it('skips a change type it does not recognise', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        {
          ...baseExp,
          type: 'copy',
          variations: [
            { id: 1, identifier: 0, traffic: 0, changes: [] },
            { id: 2, identifier: 1, traffic: 100, changes: [{ type: 'bogus', content: 'x' }] },
          ],
        },
      ],
    });
    expect(cfg.experiments[0]?.variations.find((v) => v.variation_id === 1)?.changes).toEqual([]);
  });

  it('maps goals through (crobot GoalResource → GoalConfig)', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        {
          ...baseExp,
          goals: [
            {
              id: 7,
              title: 'Quiz reached',
              type: 'page_view',
              action: '/quiz',
              match_type: 'contains',
              rank: 1,
            },
            { id: 8, title: 'CTA click', type: 'click', action: '#cta', match_type: null, rank: 2 },
            { id: 9, title: 'Signup', type: 'custom', action: 'signup_done', rank: 3 },
          ],
        },
      ],
    });
    expect(cfg.experiments[0]?.goals).toEqual([
      {
        goal_id: 7,
        name: 'Quiz reached',
        type: 'page_view',
        action: '/quiz',
        match_type: 'contains',
      },
      { goal_id: 8, name: 'CTA click', type: 'click', action: '#cta' },
      { goal_id: 9, name: 'Signup', type: 'custom', action: 'signup_done' },
    ]);
  });

  it('drops goals with an unknown type or missing action/id', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        {
          ...baseExp,
          goals: [
            { id: 1, title: 'Bogus', type: 'scroll_depth', action: '50%' },
            { id: 2, title: 'No action', type: 'click', action: '' },
            { title: 'No id', type: 'custom', action: 'x' },
          ],
        },
      ],
    });
    expect(cfg.experiments[0]?.goals).toEqual([]);
  });

  it('normalises an unrecognised goal match_type to contains', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        {
          ...baseExp,
          goals: [{ id: 7, type: 'page_view', action: '/quiz', match_type: 'site_wide' }],
        },
      ],
    });
    expect(cfg.experiments[0]?.goals).toEqual([
      { goal_id: 7, type: 'page_view', action: '/quiz', match_type: 'contains' },
    ]);
  });

  it('compiles a starts_with goal to regex ^ + escaped action (the pixel has no prefix mode)', async () => {
    const action = 'https://shop.example/thanks?(a)+[b].*$';
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        { ...baseExp, goals: [{ id: 7, type: 'page_view', action, match_type: 'starts_with' }] },
      ],
    });
    const goal = cfg.experiments[0]?.goals[0];
    expect(goal).toEqual({
      goal_id: 7,
      type: 'page_view',
      action: '^https://shop\\.example/thanks\\?\\(a\\)\\+\\[b\\]\\.\\*\\$',
      match_type: 'regex',
    });
    // Through the pixel's real matcher it behaves exactly like startsWith.
    const urlMatchesGoal = await loadPixelUrlMatch();
    for (const url of [action, `${action}/more`, `x${action}`, 'https://shop.example/thanks']) {
      expect(urlMatchesGoal(url, goal?.action ?? '', goal?.match_type)).toBe(
        url.startsWith(action),
      );
    }
  });

  it('matches a page goal whose value is a path against the URL after its scheme and host', async () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [
        {
          ...baseExp,
          goals: [
            { id: 7, type: 'page_view', action: '/thank-you', match_type: 'starts_with' },
            { id: 8, type: 'page_view', action: '/thank-you', match_type: 'exact' },
          ],
        },
      ],
    });
    const [startsWith, exact] = cfg.experiments[0]?.goals ?? [];
    const urlMatchesGoal = await loadPixelUrlMatch();
    const fires = (goal: typeof startsWith, url: string) =>
      urlMatchesGoal(url, goal?.action ?? '', goal?.match_type);

    expect(fires(startsWith, 'https://shop.example/thank-you')).toBe(true);
    expect(fires(startsWith, 'https://shop.example/thank-you/order?n=1')).toBe(true);
    expect(fires(startsWith, 'http://www.shop.example/thank-you')).toBe(true);
    expect(fires(startsWith, 'https://shop.example/en/thank-you')).toBe(false);
    expect(fires(startsWith, 'https://shop.example/?r=/thank-you')).toBe(false);
    expect(fires(exact, 'https://shop.example/thank-you')).toBe(true);
    expect(fires(exact, 'https://shop.example/thank-you?n=1')).toBe(false);
    expect(fires(exact, 'https://shop.example/thank-you/more')).toBe(false);
  });

  it('still ignores experiment types that are neither split_url nor copy', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, type: 'feature_flag' }],
    });
    expect(cfg.experiments).toHaveLength(0);
  });
});
