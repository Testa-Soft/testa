/**
 * Eligibility gates + legacy crobot tracking in the experiment cycle — the gaps
 * the live pixel e2e (plain `<script>` site against the local stack) exposed:
 *
 *   - every active experiment was bucketed + applied on EVERY page (the
 *     experiment URL / page rules were never read);
 *   - crobot `targeting` / `exclusions` were never evaluated;
 *   - no `POST /api/leads` / `/api/leads/convert` was ever sent, so crobot had
 *     no leads and v1 results stayed empty.
 */

import type { ExperimentConfig, ProjectConfig } from '@testa-platform/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPixelState } from '../../__test-utils__/reset.ts';
import { installQueue } from '../../loader/queue.ts';
import { consent } from '../consent.ts';
import * as cookies from '../cookies.ts';
import { hydrate, __resetForTests as resetLifecycle } from '../lifecycle.ts';

const HOST = 'https://crobot.example';
const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

function exp(id: number, extra: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    experiment_id: id,
    title: `Exp ${id}`,
    status: 'active',
    traffic_allocation: 100,
    rules: [{ match_type: 'contains', url_pattern: '/landing' }],
    variations: [
      {
        variation_id: 1,
        weight: 100,
        changes: [{ type: 'change_html', selector: '#hero', content: 'Variant' }],
      },
    ],
    goals: [
      { goal_id: 501, type: 'page_view', action: '/thank-you', match_type: 'contains' },
      { goal_id: 502, type: 'custom', action: 'signup' },
    ],
    ...extra,
  };
}

function boot(
  path: string,
  experiments: ExperimentConfig[],
  consentMode: 'aware' | 'strict' = 'aware',
): void {
  history.replaceState(null, '', path);
  const project: ProjectConfig = {
    project_id: 7,
    slug: 'p7',
    integration_version: '4.0',
    consent_mode: consentMode,
    experiments,
    published_at: '',
    config_hash: 'h',
  };
  window.cfPrefill = { project, trackingHost: HOST };
  installQueue();
  hydrate();
}

const posts = (path: string): Array<Record<string, unknown>> =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === `${HOST}${path}`)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(async () => {
  await resetPixelState();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  globalThis.fetch = fetchMock as typeof fetch;
  document.body.innerHTML = '<h1 id="hero">Original</h1>';
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await resetPixelState();
  history.replaceState(null, '', '/');
});

describe('page-rule gate', () => {
  it('does not bucket, expose or mutate off the experiment page', () => {
    boot('/about', [exp(11)]);
    expect(cookies.getAssignment(11)).toBeNull();
    expect(document.getElementById('hero')?.textContent).toBe('Original');
    expect(posts('/api/leads')).toEqual([]);
  });

  it('enrolls, applies and POSTs the exposure lead on the experiment page', () => {
    boot('/landing?utm_source=x&email=a@b.co', [exp(11)]);
    expect(cookies.getAssignment(11)).toBe(1);
    expect(document.getElementById('hero')?.textContent).toBe('Variant');
    const [lead] = posts('/api/leads');
    expect(lead).toMatchObject({ project_id: 7, experiment: 11, variation: 1, title: 'Exp 11' });
    expect(lead?.uuid).toBe(cookies.getUuid());
    expect(String(lead?.url)).not.toContain('a@b.co'); // GDPR scrub
  });

  it('keeps goals armed off-page for an assigned visitor (conversion → /api/leads/convert)', () => {
    boot('/landing', [exp(11)]);
    boot2('/thank-you', [exp(11)]);
    const [conv] = posts('/api/leads/convert');
    expect(conv).toMatchObject({ goal_id: 501, action: '/thank-you', variation: 1 });
    expect(conv?.lead_uuid).toBe(cookies.getUuid());
  });
});

describe('crobot targeting + exclusions', () => {
  const targeted = exp(12, {
    targeting: [{ dimension: 'utm_source', operator: 'equals', value: 'pxtest' }],
    exclusions: [{ dimension: 'cookie', operator: 'equals', value: 'px_exclude' }],
  });

  it('a failed targeting group keeps the visitor out', () => {
    boot('/landing', [targeted]);
    expect(cookies.getAssignment(12)).toBeNull();
    expect(posts('/api/leads')).toEqual([]);
  });

  it('a passing targeting group lets the visitor in', () => {
    boot('/landing?utm_source=pxtest', [targeted]);
    expect(cookies.getAssignment(12)).toBe(1);
  });

  it('a matching exclusion keeps a targeted visitor out', () => {
    document.cookie = 'px_exclude=1; path=/';
    boot('/landing?utm_source=pxtest', [targeted]);
    expect(cookies.getAssignment(12)).toBeNull();
    expect(document.getElementById('hero')?.textContent).toBe('Original');
  });
});

describe('custom goals + consent', () => {
  it('a window-API custom event POSTs the conversion with its (scrubbed) data', () => {
    boot('/landing', [exp(11)]);
    window._testa?.track('signup', { plan: 'pro', email: 'a@b.co' });
    const [conv] = posts('/api/leads/convert');
    expect(conv).toMatchObject({ goal_id: 502, action: 'signup', data: { plan: 'pro' } });
    expect((conv?.data as Record<string, unknown>).email).toBeUndefined();
  });

  it('strict consent parks the legacy calls until granted', () => {
    boot('/landing', [exp(11)], 'strict');
    expect(posts('/api/leads')).toEqual([]);
    consent.setState('granted');
    expect(posts('/api/leads')).toHaveLength(1);
  });
});

/** A second page load in the same browser (cookies kept, runtime re-hydrated). */
function boot2(path: string, experiments: ExperimentConfig[]): void {
  resetRuntimeOnly();
  boot(path, experiments);
}

function resetRuntimeOnly(): void {
  const w = window as unknown as Record<string, unknown>;
  w._testa = undefined;
  w.cfPrefill = undefined;
  // Re-arm hydrate() without clearing cookies (a new page, same visitor).
  resetLifecycle();
}

describe('conversion events on the /track pipe', () => {
  it('carry goal_id top-level (the ClickHouse column v2 goal results join on)', async () => {
    const { __getPendingEventsForTests } = await import('../lifecycle.ts');
    boot('/landing', [exp(11, { platform_version: 'v2' })]);
    window._testa?.track('signup', { plan: 'pro' });
    const conv = __getPendingEventsForTests().find(
      (e) => e.event?.event_name === 'conversion',
    )?.event;
    expect(conv?.goal_id).toBe(502);
    expect(conv?.props?.goal_id).toBeUndefined();
  });
});
