/**
 * The cold-fallback trigger. The stakes are asymmetric: fail to fire and a
 * pageview the proxy deferred is silently unexperimented (no bucketing, no
 * redirect, no DOM changes — on this visit and every later one, because the
 * normal path is cookie-first); fire when the server already decided and the
 * client re-runs the engine over a settled assignment.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import { clientOwnsDecision } from '../cold-decision.ts';

// `splitUrlConfig()`: experiment 101 enrolls on https://acme.com/pricing;
// variation 1 = control (no changes), variation 2 = redirect to /pricing-v2.
const CONTROL_URL = 'https://acme.com/pricing';
const VARIANT_URL = 'https://acme.com/pricing-v2';
const OFF_PAGE = 'https://acme.com/blog';

/** `_testa_exp` segment: `expId.variation.excluded.sessionExp`. */
const packed = (expId: number, variation: number, excluded = 0): string =>
  `${expId}.${variation}.${excluded}.0`;

/** The server HAD a config, so only the client-side triggers can fire. */
const decide = (config: ProjectConfig, cookieValue: string | null, currentUrl: string): boolean =>
  clientOwnsDecision({ config, cookieValue, currentUrl, hasServerConfig: true });

function withStatus(status: 'active' | 'paused'): ProjectConfig {
  const config = splitUrlConfig();
  return {
    ...config,
    experiments: config.experiments.map((experiment) => ({ ...experiment, status })),
  };
}

describe('clientOwnsDecision', () => {
  describe('trigger 1 — no server config', () => {
    it('fires whatever the cookie says: a server with no config decided nothing', () => {
      const input = {
        config: splitUrlConfig(),
        cookieValue: packed(101, 1),
        currentUrl: CONTROL_URL,
        hasServerConfig: false,
      };
      expect(clientOwnsDecision(input)).toBe(true);
      expect(clientOwnsDecision({ ...input, hasServerConfig: true })).toBe(false);
    });
  });

  describe('trigger 2 — cookie gap', () => {
    it('fires when nothing decided this pageview (the cold isolate case)', () => {
      expect(decide(splitUrlConfig(), null, CONTROL_URL)).toBe(true);
    });

    it('fires when the cookie holds OTHER experiments but not this one', () => {
      expect(decide(splitUrlConfig(), packed(999, 1), CONTROL_URL)).toBe(true);
    });

    it('FIRES on the eligible-pending sentinel — parked is not decided', () => {
      // -2 means "targeting passed, not yet bucketed", which the engine upgrades
      // to a real variation the moment the visitor reaches the experiment's
      // page. Reading it as a decision strands those visitors on the control.
      expect(decide(splitUrlConfig(), packed(101, -2), CONTROL_URL)).toBe(true);
    });

    it('leaves a real assignment alone (cookie-first, never re-rolled)', () => {
      expect(decide(splitUrlConfig(), packed(101, 1), CONTROL_URL)).toBe(false);
    });

    it('fires on a cached exclusion — the engine re-applies its own verdict', () => {
      // Running the engine over an excluded visitor is a no-op cycle: it sees
      // the cached exclusion and decides nothing. Cheap, and it means an
      // expired cooldown is re-evaluated even when the proxy never runs.
      expect(decide(splitUrlConfig(), packed(101, -1, 1), CONTROL_URL)).toBe(true);
    });

    it('ignores experiments whose page rule does not match this URL', () => {
      expect(decide(splitUrlConfig(), null, OFF_PAGE)).toBe(false);
    });

    it('ignores experiments that are not active', () => {
      expect(decide(withStatus('paused'), null, CONTROL_URL)).toBe(false);
    });

    it('is false for a config with no experiments at all', () => {
      expect(decide({ ...splitUrlConfig(), experiments: [] }, null, CONTROL_URL)).toBe(false);
    });
  });

  describe('trigger 3 — a pinned redirect the server never honoured', () => {
    it('fires for a visitor pinned to the redirect variant who is on the CONTROL url', () => {
      // The sticky assignment means no cookie gap will ever appear again, and the
      // cookie-first apply path skips redirect changes — so without this trigger
      // the visitor sees the control page forever while counted in the variant.
      expect(decide(splitUrlConfig(), packed(101, 2), CONTROL_URL)).toBe(true);
    });

    it('stands down once they are AT the destination (no redirect loop)', () => {
      expect(decide(splitUrlConfig(), packed(101, 2), VARIANT_URL)).toBe(false);
    });

    it('stands down for the control variation — nothing to honour', () => {
      expect(decide(splitUrlConfig(), packed(101, 1), CONTROL_URL)).toBe(false);
    });
  });
});

/**
 * An EXCLUDED visitor is not an undecided one. The engine skips them before
 * `assign()` and persists nothing, so their cookie is byte-identical to a
 * merely-eligible visitor's (`cacheEligible` already wrote the `-2` sentinel).
 * Reading that as a gap handed the client engine exactly the population the
 * server had just excluded.
 */
describe('exclusions are not a cookie gap', () => {
  const withExclusion = (): ProjectConfig => {
    const cfg = splitUrlConfig();
    // biome-ignore lint/style/noNonNullAssertion: fixture always has one experiment
    cfg.experiments[0]!.exclusions = [
      { dimension: 'url', operator: 'contains', value: 'flow=checkout11' },
    ];
    return cfg;
  };

  it('does not claim the pageview when an exclusion matches (sentinel cookie)', () => {
    expect(
      clientOwnsDecision({
        config: withExclusion(),
        cookieValue: '101.-2.0.9999999999',
        currentUrl: `${CONTROL_URL}?flow=checkout11`,
        hasServerConfig: true,
      }),
    ).toBe(false);
  });

  it('does not claim it with no cookie at all', () => {
    expect(
      clientOwnsDecision({
        config: withExclusion(),
        cookieValue: null,
        currentUrl: `${CONTROL_URL}?flow=checkout11`,
        hasServerConfig: true,
      }),
    ).toBe(false);
  });

  it('still claims a genuine gap on the same page when nothing excludes', () => {
    expect(
      clientOwnsDecision({
        config: withExclusion(),
        cookieValue: '101.-2.0.9999999999',
        currentUrl: CONTROL_URL,
        hasServerConfig: true,
      }),
    ).toBe(true);
  });

  it('a missing server config still wins over any exclusion (nothing decided at all)', () => {
    expect(
      clientOwnsDecision({
        config: withExclusion(),
        cookieValue: null,
        currentUrl: `${CONTROL_URL}?flow=checkout11`,
        hasServerConfig: false,
      }),
    ).toBe(true);
  });
});
