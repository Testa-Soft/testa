// @vitest-environment happy-dom
/**
 * `trackPageView` — the pixel's lifecycle events from the SDKs (PRD-002 parity
 * on the PRD-006 pipeline): `session_start` on the first view of a new session,
 * `page_view` per route, sent with or without an active experiment session;
 * goal conversions reach `/track` with `goal_id` on top.
 */
import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { resetConversionGuard, resetGoalRegistry } from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE } from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentCookieStore, __resetMemoryTier } from '../cookie-store.ts';
import { startGoalTracking } from '../goal-tracking.ts';
import { __resetTrackingForTests, startPrd006Tracking, trackPageView } from '../track.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const T0_SEC = T0 / 1000;
const EXP = 7;

const config: ProjectConfig = {
  project_id: 42,
  slug: 'demo',
  integration_version: '4.0',
  consent_mode: 'aware',
  experiments: [
    {
      experiment_id: EXP,
      status: 'active',
      traffic_allocation: 100,
      rules: [],
      variations: [{ variation_id: 1, weight: 100, changes: [] }],
      goals: [{ goal_id: 510, type: 'page_view', match_type: 'contains', action: '/thanks' }],
      platform_version: 'v2',
    },
  ],
  published_at: '',
  config_hash: 'h',
};

let sent: PixelEvent[] = [];
let stop: () => void = () => undefined;

function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; max-age=0; path=/`;
  }
}

function start(assignment: string): DocumentCookieStore {
  document.cookie = `${ASSIGNMENT_COOKIE}=${assignment}; path=/`;
  const store = new DocumentCookieStore({ secure: false, mirrorToStorage: false });
  stop = startPrd006Tracking({ config, store, send: (events) => sent.push(...events) });
  return store;
}

const names = () => sent.map((e) => e.event_name);

beforeEach(() => {
  clearCookies();
  __resetMemoryTier();
  __resetTrackingForTests();
  sent = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('trackPageView', () => {
  it('session_start once on a new session, then page_view inside the experiment session', () => {
    start(`${EXP}.1.0.0`);
    trackPageView();
    trackPageView();
    expect(names()).toEqual(['session_start', 'page_view', 'page_view']);
    expect(sent[1]).toMatchObject({ exp: [[EXP, 1, T0_SEC, 1]], in_experiment: 1 });
  });

  it('no session_start when a session already existed', () => {
    document.cookie = '_testa_sid=existing; path=/';
    start(`${EXP}.1.0.0`);
    trackPageView();
    expect(names()).toEqual(['page_view']);
    expect(sent[0]?.session_id).toBe('existing');
  });

  it('page_view is sent outside experiments with in_experiment = 0', () => {
    start(`${EXP}.-1.0.0`);
    trackPageView();
    expect(sent.find((e) => e.event_name === 'page_view')).toMatchObject({
      exp: [],
      in_experiment: 0,
    });
  });

  it('crawlers send nothing', () => {
    start(`${EXP}.1.0.0`);
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Googlebot/2.1');
    trackPageView();
    ua.mockRestore();
    expect(sent).toEqual([]);
  });

  it('is a no-op before tracking started', () => {
    expect(() => trackPageView()).not.toThrow();
    expect(sent).toEqual([]);
  });
});

describe('goal conversions on v2', () => {
  it('go to /track as `conversion` with goal_id, and still POST crobot', () => {
    resetConversionGuard();
    resetGoalRegistry();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = start(`${EXP}.1.0.0`);
    const teardown = startGoalTracking(
      config,
      store.get(ASSIGNMENT_COOKIE),
      'https://site.example/thanks',
      'uuid-1',
      'https://crobot.example',
      T0_SEC,
    );
    teardown();
    vi.unstubAllGlobals();

    expect(sent.find((e) => e.event_name === 'conversion')).toMatchObject({
      goal_id: 510,
      experiment_id: EXP,
      variation_id: 1,
      exp: [[EXP, 1, T0_SEC, 1]],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://crobot.example/api/leads/convert');
  });
});
