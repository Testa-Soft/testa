import type { ProjectConfig } from '@testa-platform/shared-types';

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
