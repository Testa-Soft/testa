/**
 * The Pages Router head-shield rule. The default is what matters here: a page
 * that knows nothing yet (only a `projectId`) MUST be shielded, because the
 * decision is made before the config can possibly have arrived — and the
 * flash it prevents (server-rendered control → variant) is not recoverable
 * afterwards.
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { describe, expect, it } from 'vitest';
import { splitUrlConfig } from '../../__tests__/helpers.ts';
import { shouldRenderHeadShield } from '../shield-decision.ts';

const base = { hasPagesRouter: true, settled: false };

/** A config whose experiments carry no changes at all — nothing to hide. */
function emptyConfig(): ProjectConfig {
  const config = splitUrlConfig();
  return {
    ...config,
    experiments: config.experiments.map((experiment) => ({
      ...experiment,
      variations: experiment.variations.map((variation) => ({ ...variation, changes: [] })),
    })),
  };
}

describe('shouldRenderHeadShield', () => {
  it('shields by default — no config, no opt-in needed', () => {
    expect(shouldRenderHeadShield(base)).toBe(true);
  });

  it('stops shielding once the cycle has settled', () => {
    expect(shouldRenderHeadShield({ ...base, settled: true })).toBe(false);
  });

  it('honours shield={false} — the app owns anti-flicker', () => {
    expect(shouldRenderHeadShield({ ...base, shield: false })).toBe(false);
  });

  it('still shields with shield options (an object is customisation, not opt-out)', () => {
    expect(shouldRenderHeadShield({ ...base, shield: { timeoutMs: 1000 } })).toBe(true);
  });

  it('does not shield without a Pages Router (next/head is inert in the App Router)', () => {
    expect(shouldRenderHeadShield({ ...base, hasPagesRouter: false })).toBe(false);
  });

  it('skips the shield when an inline config has nothing to hide', () => {
    expect(shouldRenderHeadShield({ ...base, config: emptyConfig() })).toBe(false);
  });

  it('shields on an inline config that does carry changes', () => {
    expect(shouldRenderHeadShield({ ...base, config: splitUrlConfig() })).toBe(true);
  });
});
