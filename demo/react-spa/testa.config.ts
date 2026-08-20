import type { ProjectConfig } from '@testa-platform/shared-types';

/**
 * PROD-CONFIG MODE — run the SPA against the real config API instead of the
 * inline fixture: `VITE_TESTA_DEMO_PROD=1 pnpm dev`. The demo consumes the
 * WORKSPACE package source, so this is the no-publish loop for testing SDK
 * changes against real crobot-authored experiments (the config API sends
 * `access-control-allow-origin: *`, so the browser fetch works cross-origin).
 * Exposure tracking stays OFF so test enrollments never pollute real results.
 */
export const PROD_PROJECT_ID = '6a8418d12335d';
export const useProdConfig = import.meta.env.VITE_TESTA_DEMO_PROD === '1';

/**
 * Config host in prod mode. Defaults to the Vite dev proxy (`/__testa-config`
 * → collector on Fly, see vite.config.ts) so crobot publishes land within the
 * SDK's own 30s cache instead of the CDN's 10-minute edge cache. Override with
 * `VITE_TESTA_CONFIG_HOST` (e.g. the real CDN host to test the CDN path).
 */
export const PROD_CONFIG_HOST = import.meta.env.VITE_TESTA_CONFIG_HOST ?? '/__testa-config';

/**
 * Inline demo config (crobot-native) — zero infra. Two experiments that showcase
 * the ROBUST paths for a React SPA (both survive React re-render + SPA nav):
 *
 *   202 — a `css` change (#hero color). CSS is injected into <head>, which React
 *         never reconciles, so it's rock-solid across navigation.
 *   303 — a "code-based" experiment the app renders itself via `useTestaVariant`.
 *         React owns the variant markup, so it can't be clobbered.
 *
 * (Content-mutation like `change_html`/`append_html` also works, but on elements
 * React re-renders it fights reconciliation — prefer `useTestaVariant` there.)
 */
export const demoConfig: ProjectConfig = {
  project_id: 1,
  slug: 'react-demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  published_at: '2026-08-18T00:00:00.000Z',
  config_hash: 'react-demo-2',
  experiments: [
    {
      // PAGE-SCOPED change_html — regression fixture for (a) the soft-nav leak
      // (variant h1 only on /features, never elsewhere) and (b) the React-
      // clobber keeper (soft-nav BACK to /features must re-apply even though
      // React reuses the same <h1> element and rewrites its text).
      experiment_id: 404,
      title: 'Features H1 rewrite (page-scoped)',
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/features' }],
      goals: [],
      variations: [
        { variation_id: 1, weight: 0, changes: [] },
        {
          variation_id: 2,
          weight: 100,
          changes: [{ type: 'change_html', selector: 'h1', content: 'Features — variant ✅' }],
        },
      ],
    },
    {
      experiment_id: 202,
      title: 'Hero colour (css)',
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        {
          variation_id: 2,
          name: 'Variant',
          weight: 100,
          changes: [{ type: 'css', content: '#hero{color:#c2185b}' }],
        },
      ],
    },
    {
      experiment_id: 303,
      title: 'CTA copy (code-based)',
      status: 'active',
      traffic_allocation: 100,
      rules: [{ match_type: 'contains', url_pattern: '/' }],
      goals: [],
      variations: [
        { variation_id: 1, name: 'Control', weight: 0, changes: [] },
        { variation_id: 2, name: 'Variant', weight: 100, changes: [] },
      ],
    },
  ],
};
