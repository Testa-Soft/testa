import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * PROD-CONFIG MODE — run the demo against the real config API instead of the
 * inline fixture below: `TESTA_DEMO_PROD=1 pnpm dev`. The demo consumes the
 * WORKSPACE packages (unpublished code), so this is the loop for testing SDK
 * changes against real crobot-authored experiments without publishing:
 * edit in crobot → publish → both config caches revalidate within ~30s.
 * Exposure tracking stays OFF in the demo either way, so test enrollments
 * never pollute the real project's results.
 */
export const PROD_PROJECT_ID = '6a8418d12335d';
export const useProdConfig = process.env.TESTA_DEMO_PROD === '1';

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
  config_hash: 'demo-3',
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
      // PAGE-SCOPED change_html — regression fixture for the soft-nav leak: the
      // variant H1 must show ONLY on /features; soft-navigating to any other
      // page must show that page's own, untouched H1 (guard + teardown-undo).
      experiment_id: 303,
      title: 'Features H1 rewrite (page-scoped)',
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/features' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        {
          variation_id: 2,
          name: 'Variant (H1 rewrite)',
          weight: 100,
          changes: [
            { type: 'change_html', selector: 'h1', content: 'Features — variant H1 ✅' },
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
