import { describe, expect, it } from 'bun:test';
import { buildTestaConfig } from '../build.ts';

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

  it("emits nav:'rewrite' on the redirect change when the experiment asks for it", () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, nav: 'rewrite' }],
    });
    const change = cfg.experiments[0]?.variations[1]?.changes[0];
    expect(change).toMatchObject({ type: 'redirect', nav: 'rewrite' });
  });

  it('omits nav entirely for the default redirect delivery (keeps config_hash stable)', () => {
    const cfg = buildTestaConfig(sourceProject);
    const change = cfg.experiments[0]?.variations[1]?.changes[0];
    expect(change).not.toHaveProperty('nav');
  });

  it('treats an unrecognised nav value as the default redirect', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, nav: 'teleport' }],
    });
    expect(cfg.experiments[0]?.variations[1]?.changes[0]).not.toHaveProperty('nav');
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

  it('still ignores experiment types that are neither split_url nor copy', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, type: 'feature_flag' }],
    });
    expect(cfg.experiments).toHaveLength(0);
  });
});
