import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * Inline demo config. In production this comes from crobot (CDN hashed JSON /
 * Edge Config) — see PRD 003. Here it's static so the demo runs with zero infra.
 *
 * One split-URL experiment: 50/50 control (`/pricing`) vs variant
 * (`/pricing-v2`). The redirect uses a path-anchored regex so it's independent
 * of host/port and never re-matches the variant URL.
 */
export const demoConfig: ProjectConfig = {
  project_id: 1,
  slug: 'demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'demo-1',
  experiments: [
    {
      experiment_id: 101,
      title: 'Pricing page split-URL test',
      status: 'active',
      traffic_allocation: 100,
      rules: [],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control (/pricing)', weight: 50, changes: [] },
        {
          variation_id: 2,
          name: 'Variant (/pricing-v2)',
          weight: 50,
          changes: [
            {
              type: 'redirect',
              from_url: '/pricing$',
              to_url: '/pricing-v2',
              url_match_type: 'regex',
            },
          ],
        },
      ],
    },
  ],
};
