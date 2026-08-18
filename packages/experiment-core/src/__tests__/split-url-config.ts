import type { ProjectConfig, VariationChange } from '@testa-platform/shared-types';

const redirectChange = (from: string, to: string): VariationChange => ({
  type: 'redirect',
  from_url: from,
  to_url: to,
});

/** A ProjectConfig with a single active split-URL experiment (engine-test fixture). */
export function splitUrlConfig(
  over: {
    from?: string;
    to?: string;
    traffic?: number;
    status?: 'active' | 'paused' | 'archived';
  } = {},
): ProjectConfig {
  const from = over.from ?? 'https://acme.com/pricing';
  const to = over.to ?? 'https://acme.com/pricing-v2';
  return {
    project_id: 1,
    slug: 'acme',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '2026-08-04T00:00:00.000Z',
    config_hash: 'hash-1',
    experiments: [
      {
        experiment_id: 101,
        status: over.status ?? 'active',
        traffic_allocation: over.traffic ?? 100,
        rules: [{ match_type: 'exact', url_pattern: from }],
        goals: [],
        variations: [
          { variation_id: 1, weight: 50, changes: [] },
          { variation_id: 2, weight: 50, changes: [redirectChange(from, to)] },
        ],
      },
    ],
  };
}
