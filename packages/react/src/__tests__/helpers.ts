import type {
  ExperimentConfig,
  ProjectConfig,
  VariationChange,
} from '@testa-platform/shared-types';
import type { CookieStore } from '@testa-soft/experiment-core';

/** The first experiment of a fixture config (no non-null assertions in tests). */
export function firstExperiment(config: ProjectConfig): ExperimentConfig {
  const exp = config.experiments[0];
  if (!exp) throw new Error('fixture config has no experiments');
  return exp;
}

/** An in-memory `CookieStore` for pure-logic tests (no `document`). */
export function memoryStore(initial: Record<string, string> = {}): CookieStore & {
  dump(): Record<string, string>;
} {
  const jar = new Map<string, string>(Object.entries(initial));
  return {
    get: (name) => jar.get(name) ?? null,
    set: (name, value) => {
      jar.set(name, value);
    },
    dump: () => Object.fromEntries(jar),
  };
}

const redirectChange = (from: string, to: string): VariationChange => ({
  type: 'redirect',
  from_url: from,
  to_url: to,
});

/** A ProjectConfig with a single active split-URL experiment (variant 2 redirects). */
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
        title: 'Pricing test',
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

/** A ProjectConfig with a single active DOM-only experiment (variant 2 changes #hero). */
export function domConfig(over: { content?: string; traffic?: number } = {}): ProjectConfig {
  const config = splitUrlConfig({ traffic: over.traffic ?? 100 });
  const experiment = config.experiments[0];
  if (experiment) {
    experiment.variations = [
      { variation_id: 1, weight: 0, changes: [] },
      {
        variation_id: 2,
        weight: 100,
        changes: [{ type: 'change_html', selector: '#hero', content: over.content ?? 'VARIANT' }],
      },
    ];
  }
  return config;
}

/**
 * Point happy-dom's LIVE `window.location` at `url`. The apply guard re-checks
 * the page rule against the live URL on every DOM touch (soft-nav safety), so
 * tests that expect changes to apply must move the window there first.
 */
export function setWindowUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL: (u: string) => void } }).happyDOM?.setURL(url);
}
