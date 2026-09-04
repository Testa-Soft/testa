import type { ProjectConfig, VariationChange } from '@testa-platform/shared-types';
import type { CookieStore } from '@testa-soft/experiment-core';
import type { ReadableCookies } from '../cookie-store.ts';

export function memoryStore(initial: Record<string, string> = {}): CookieStore & {
  dump(): Record<string, string>;
} {
  const jar = new Map<string, string>(Object.entries(initial));
  return {
    get: (name) => jar.get(name) ?? null,
    set: (name, value) => {
      jar.set(name, value);
    },
    names: () => [...jar.keys()],
    dump: () => Object.fromEntries(jar),
  };
}

/** A `ReadableCookies` (next req.cookies shape) from a plain record. */
export function reqCookies(initial: Record<string, string> = {}): ReadableCookies {
  return {
    get: (name) => (name in initial ? { value: initial[name] as string } : undefined),
  };
}

/** A fake `WritableCookies` (next res.cookies shape) that records writes. */
export function resCookies(): {
  set(name: string, value: string, opts: Record<string, unknown>): void;
  written: Map<string, { value: string; opts: Record<string, unknown> }>;
} {
  const written = new Map<string, { value: string; opts: Record<string, unknown> }>();
  return {
    written,
    set: (name, value, opts) => {
      written.set(name, { value, opts });
    },
  };
}

const redirectChange = (from: string, to: string): VariationChange => ({
  type: 'redirect',
  from_url: from,
  to_url: to,
});

/** A ProjectConfig with a single active split-URL experiment. */
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
        // Page rule = the experiment's URL; the engine only enrolls on this page.
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
