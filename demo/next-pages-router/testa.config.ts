import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * Inline demo config — zero infra, same shape crobot publishes. Two experiments:
 *   - 101 split-URL: 50/50 control (`/pricing`) vs variant (`/pricing-v2`).
 *     Hard loads: server-side 307 by the proxy. Soft navs (`next/link`):
 *     client-side re-point by the router guard the `/pages` provider wires in.
 *   - 202 site-wide hero badge (append_html + css): applied client-side by the
 *     provider's engine, re-applied on every navigation.
 */

/** The project id used in slow mode (`pnpm dev:slow`) — any string works. */
export const DEMO_PROJECT_ID = 'pages-demo';

/**
 * How long the demo's own config endpoint stalls, in slow mode. The shield is
 * up for exactly this long, which is the point: with the real (instant) config
 * there is nothing to see.
 */
export const DEMO_DELAY_MS = Number(process.env.NEXT_PUBLIC_TESTA_SLOW_MS ?? 0);

export const demoConfig: ProjectConfig = {
  project_id: 1,
  slug: 'pages-demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'pages-demo-1',
  experiments: [
    {
      // Dynamic-route split URL with query params — the shape a quiz funnel has.
      // `to_url` is ABSOLUTE on purpose: that is how crobot authors it, and it
      // is the case that decides whether the soft-nav guard stays a soft nav.
      experiment_id: 404,
      title: 'Question funnel — male → female',
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/question/male' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        {
          variation_id: 2,
          name: 'Variant (female)',
          weight: 100,
          changes: [
            {
              type: 'redirect',
              from_url: 'http://localhost:3300/question/male/1',
              to_url: 'http://localhost:3300/question/female/1',
              url_match_type: 'exact',
            },
          ],
        },
      ],
    },
    {
      experiment_id: 101,
      title: 'Pricing page split-URL test',
      status: 'active',
      traffic_allocation: 100,
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
      rules: [{ match_type: 'contains', url_pattern: '/' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        {
          variation_id: 2,
          name: 'Variant (append_html + css)',
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
