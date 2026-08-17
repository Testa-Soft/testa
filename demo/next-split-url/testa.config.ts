import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * Inline demo config. In production this comes from crobot (its ProjectResource
 * JSON, served by the collector config API) — see PRD 003. Here it's static so
 * the demo runs with zero infra. Change shapes are crobot-native (`change_html`
 * / `css` with `content`) — exactly what crobot authors, no adapter.
 *
 * Two experiments:
 *   - 101 split-URL: 50/50 control (`/pricing`) vs variant (`/pricing-v2`),
 *     server-side 307 (flicker-free).
 *   - 202 HTML/DOM on the home page: 100% to the variant so it's always visible.
 *     The middleware assigns it (writes `_testa_exp`); `<TestaExperiments/>`
 *     applies the crobot changes client-side, shielded against flicker.
 */
export const demoConfig: ProjectConfig = {
  project_id: 1,
  slug: 'demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'demo-2',
  experiments: [
    {
      experiment_id: 101,
      title: 'Pricing page split-URL test',
      status: 'active',
      traffic_allocation: 100,
      // Only enroll on /pricing (not the home page).
      rules: [{ match_type: 'contains', url_pattern: '/pricing' }],
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
    {
      experiment_id: 202,
      title: 'Site-wide hero badge (HTML)',
      status: 'active',
      traffic_allocation: 100,
      // Site-wide: enroll on any page. It only *shows* where #hero exists
      // (home/features/about) — the pricing pages have no #hero, so it's a no-op
      // there. The client re-applies on every soft navigation.
      rules: [{ match_type: 'contains', url_pattern: '/' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        {
          variation_id: 2,
          name: 'Variant (crobot append_html + css)',
          weight: 100,
          changes: [
            {
              type: 'append_html',
              selector: '#hero',
              content: ' <span class="testa-badge">✨ variant</span>',
            },
            {
              type: 'css',
              content: '.testa-badge{color:#c2185b;font-size:.55em;vertical-align:middle}',
            },
          ],
        },
      ],
    },
  ],
};
