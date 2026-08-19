import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { hasPendingDomChange } from '../engine.ts';

function cfg(experiments: ProjectConfig['experiments']): ProjectConfig {
  return {
    project_id: 1,
    slug: '1',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments,
    published_at: '',
    config_hash: 'h',
  };
}

const domExp: ProjectConfig['experiments'][number] = {
  experiment_id: 10,
  status: 'active',
  traffic_allocation: 100,
  rules: [{ match_type: 'contains', url_pattern: '/pricing' }],
  goals: [],
  variations: [
    { variation_id: 0, weight: 50, changes: [] },
    {
      variation_id: 1,
      weight: 50,
      changes: [{ type: 'change_html', selector: '#h', content: 'x' }],
    },
  ],
};

const splitUrlExp: ProjectConfig['experiments'][number] = {
  experiment_id: 20,
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
};

describe('hasPendingDomChange', () => {
  it('true: assigned to a DOM variant on a matching page', () => {
    expect(hasPendingDomChange(cfg([domExp]), 'https://s.com/pricing', '10.1.0.0')).toBe(true);
  });

  it('false: split-URL experiment (redirect change) never needs the shield', () => {
    expect(hasPendingDomChange(cfg([splitUrlExp]), 'https://s.com/calculator', '20.1.0.0')).toBe(
      false,
    );
  });

  it('false: assigned to control (no changes)', () => {
    expect(hasPendingDomChange(cfg([domExp]), 'https://s.com/pricing', '10.0.0.0')).toBe(false);
  });

  it('false: DOM experiment but current page does not match its rule', () => {
    expect(hasPendingDomChange(cfg([domExp]), 'https://s.com/home', '10.1.0.0')).toBe(false);
  });

  it('false: excluded visitor', () => {
    expect(hasPendingDomChange(cfg([domExp]), 'https://s.com/pricing', '10.1.1.0')).toBe(false);
  });

  it('false: no assignment cookie at all', () => {
    expect(hasPendingDomChange(cfg([domExp]), 'https://s.com/pricing', null)).toBe(false);
  });

  it('true: one DOM experiment among a split-URL one on the same page', () => {
    const both = cfg([
      { ...splitUrlExp, rules: [{ match_type: 'contains', url_pattern: '/pricing' }] },
      domExp,
    ]);
    expect(hasPendingDomChange(both, 'https://s.com/pricing', '20.1.0.0~10.1.0.0')).toBe(true);
  });
});
