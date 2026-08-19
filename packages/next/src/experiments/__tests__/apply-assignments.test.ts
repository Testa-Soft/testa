// @vitest-environment happy-dom

/**
 * Client-side DOM apply (task: HTML experiments in @testa/next). Tests the
 * framework-agnostic core — cookie→assignment resolution + wiring into the
 * shared apply engine. The per-change appliers themselves are covered in
 * @testa-soft/dom; here we prove the cookie-first selection + end-to-end
 * "cookie → DOM mutated" wiring. The React glue (.tsx) is exercised by the demo
 * e2e.
 */

import type { ProjectConfig, VariationChange } from '@testa-platform/shared-types';
import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClientCookie } from '../../client-cookie.ts';
import {
  applyAssignedExperiments,
  resolveAssignedExperiments,
  revealShield,
} from '../apply-assignments.ts';

const cssChange = (content: string): VariationChange => ({ type: 'css', content });
const htmlChange = (selector: string, content: string): VariationChange => ({
  type: 'change_html',
  selector,
  content,
});
const redirectChange = (): VariationChange => ({
  type: 'redirect',
  from_url: 'https://acme.com/a',
  to_url: 'https://acme.com/b',
});

/** Config with a single active DOM experiment: v1 control (no changes), v2 = css+change_html. */
function domConfig(over: { status?: 'active' | 'paused' } = {}): ProjectConfig {
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
        traffic_allocation: 100,
        rules: [],
        goals: [],
        variations: [
          { variation_id: 1, weight: 50, changes: [] },
          {
            variation_id: 2,
            weight: 50,
            changes: [cssChange('#hero{color:red}'), htmlChange('#cta', 'Buy now')],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

// domConfig has `rules: []` (matches everywhere), so any URL passes its page gate.
const URL_ANY = 'https://acme.com/anything';

describe('resolveAssignedExperiments — cookie-first selection', () => {
  it('returns the variant DOM changes for an assigned visitor', () => {
    const assigned = resolveAssignedExperiments(domConfig(), '101.2.0.0', URL_ANY);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ experimentId: 101, variationId: 2 });
    expect(assigned[0]?.changes).toHaveLength(2);
  });

  it('returns nothing for a control-assigned visitor (no changes on the variant)', () => {
    expect(resolveAssignedExperiments(domConfig(), '101.1.0.0', URL_ANY)).toHaveLength(0);
  });

  it('returns nothing with no cookie (never re-buckets)', () => {
    expect(resolveAssignedExperiments(domConfig(), null, URL_ANY)).toHaveLength(0);
  });

  it('skips an excluded assignment', () => {
    expect(resolveAssignedExperiments(domConfig(), '101.-1.1.0', URL_ANY)).toHaveLength(0);
  });

  it('skips a paused experiment', () => {
    expect(
      resolveAssignedExperiments(domConfig({ status: 'paused' }), '101.2.0.0', URL_ANY),
    ).toHaveLength(0);
  });

  it('does NOT apply on a page failing the experiment page rule (assigned but off-page)', () => {
    const config = domConfig();
    const exp = config.experiments[0];
    if (exp) exp.rules = [{ match_type: 'contains', url_pattern: '/pricing' }];
    expect(resolveAssignedExperiments(config, '101.2.0.0', 'https://acme.com/home')).toHaveLength(
      0,
    );
    expect(
      resolveAssignedExperiments(config, '101.2.0.0', 'https://acme.com/pricing'),
    ).toHaveLength(1);
  });

  it('filters out redirect changes (those are the middleware’s job)', () => {
    const config = domConfig();
    const variant = config.experiments[0]?.variations[1];
    if (variant) variant.changes = [redirectChange(), cssChange('#x{top:0}')];
    const assigned = resolveAssignedExperiments(config, '101.2.0.0', URL_ANY);
    expect(assigned[0]?.changes).toHaveLength(1);
    expect(assigned[0]?.changes[0]?.type).toBe('css');
  });
});

describe('applyAssignedExperiments — end-to-end wiring (cookie → DOM)', () => {
  it('applies the assigned variant’s DOM changes to the page', () => {
    document.body.innerHTML = '<h1 id="hero">Hi</h1><button id="cta">Old</button>';
    const teardowns = applyAssignedExperiments(domConfig(), '101.2.0.0', URL_ANY);
    expect(document.querySelector<HTMLElement>('#cta')?.textContent).toBe('Buy now');
    // css applies via an injected <style> tag
    expect(document.head.querySelector('style')).not.toBeNull();
    // teardowns are returned so the caller can dispose DOM watchers
    expect(Array.isArray(teardowns)).toBe(true);
    for (const t of teardowns) t();
  });

  it('applies nothing for a control visitor', () => {
    document.body.innerHTML = '<button id="cta">Old</button>';
    applyAssignedExperiments(domConfig(), '101.1.0.0', URL_ANY);
    expect(document.querySelector<HTMLElement>('#cta')?.textContent).toBe('Old');
  });
});

describe('revealShield', () => {
  it('calls window.__testa_shield.reveal when present', () => {
    let revealed = false;
    (window as unknown as { __testa_shield?: { reveal: () => void } }).__testa_shield = {
      reveal: () => {
        revealed = true;
      },
    };
    revealShield();
    expect(revealed).toBe(true);
  });

  it('is a no-op when no shield was raised', () => {
    (window as unknown as { __testa_shield?: unknown }).__testa_shield = undefined;
    expect(() => revealShield()).not.toThrow();
  });
});

describe('readClientCookie', () => {
  it('reads a cookie value from document.cookie', () => {
    document.cookie = `${ASSIGNMENT_COOKIE}=101.2.0.0`;
    expect(readClientCookie(ASSIGNMENT_COOKIE)).toBe('101.2.0.0');
  });

  it('returns null for an absent cookie', () => {
    expect(readClientCookie('nope_missing')).toBeNull();
  });
});
