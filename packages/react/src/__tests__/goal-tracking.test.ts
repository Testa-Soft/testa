
import type { ProjectConfig } from '@testa-platform/shared-types';
import { resetConversionGuard, resetGoalRegistry } from '@testa-soft/dom';
import { serializePacked } from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGoalTracking } from '../goal-tracking.ts';

const NOW_SEC = 1_000_000_000;
const LIVE = NOW_SEC + 600;
const HOST = 'https://new.testa-soft.tech';

function cfg(): ProjectConfig {
  return {
    project_id: 1,
    slug: 'p',
    integration_version: '4.0',
    consent_mode: 'aware',
    published_at: '',
    config_hash: 'h',
    experiments: [
      {
        experiment_id: 1,
        title: 'Calc',
        status: 'active',
        traffic_allocation: 100,
        rules: [{ match_type: 'contains', url_pattern: '/calculator' }],
        goals: [
          { goal_id: 7, type: 'page_view', match_type: 'contains', action: '/quiz' },
          { goal_id: 9, type: 'custom', action: 'signup_done' },
        ],
        variations: [
          { variation_id: 0, weight: 0, changes: [] },
          { variation_id: 1, weight: 100, changes: [] },
        ],
      },
    ],
  };
}

const assignedCookie = serializePacked(
  new Map([[1, { variation: 1, excluded: false, sessionExp: LIVE }]]),
);

describe('startGoalTracking', () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

  beforeEach(() => {
    resetConversionGuard();
    resetGoalRegistry();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires a page_view conversion on a goal-matching page, even off the experiment page', () => {
    const stop = startGoalTracking(
      cfg(),
      assignedCookie,
      'https://site.example/quiz',
      'uuid-1',
      HOST,
      NOW_SEC,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${HOST}/api/leads/convert`);
    expect(JSON.parse(init.body as string)).toEqual({
      goal_id: 7,
      action: '/quiz',
      lead_uuid: 'uuid-1',
      variation: 1,
      data: {},
    });
    stop();
  });

  it('does not fire page_view off the goal page, and fires custom via window.testa.pushEvent', () => {
    const stop = startGoalTracking(
      cfg(),
      assignedCookie,
      'https://site.example/calculator',
      'uuid-1',
      HOST,
      NOW_SEC,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const w = window as unknown as {
      testa: { pushEvent: (n: string, d?: Record<string, unknown>) => void };
    };
    w.testa.pushEvent('signup_done', { plan: 'pro' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      goal_id: 9,
      action: 'signup_done',
      lead_uuid: 'uuid-1',
      variation: 1,
      data: { plan: 'pro' },
    });
    stop();
  });

  it('is inert for unassigned visitors and after teardown', () => {
    const stop = startGoalTracking(cfg(), null, 'https://site.example/quiz', 'u', HOST, NOW_SEC);
    expect(fetchMock).not.toHaveBeenCalled();
    stop();

    const stop2 = startGoalTracking(
      cfg(),
      assignedCookie,
      'https://site.example/home',
      'uuid-1',
      HOST,
      NOW_SEC,
    );
    stop2();
    (window as unknown as { testa: { pushEvent: (n: string) => void } }).testa.pushEvent(
      'signup_done',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
