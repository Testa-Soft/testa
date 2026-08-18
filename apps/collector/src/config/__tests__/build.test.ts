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

  it('still ignores experiment types that are neither split_url nor copy', () => {
    const cfg = buildTestaConfig({
      ...sourceProject,
      experiments: [{ ...baseExp, type: 'feature_flag' }],
    });
    expect(cfg.experiments).toHaveLength(0);
  });
});
