/**
 * PRD-006 experiment sessions in the pixel (task 5.5): sliding 60-min sessions,
 * `exp` stamping, drops outside a session, re-init on return, v2-only gating.
 * Fake clock (Date only) so the outbox's real timers keep working.
 */
import type { ExpSession, PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { parsePacked } from '@testa-soft/experiment-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPixelState } from '../../../__test-utils__/reset.ts';
import { installQueue } from '../../../loader/queue.ts';
import * as cookies from '../../cookies.ts';
import {
  __clearPendingEventsForTests,
  __getPendingEventsForTests,
  hydrate,
  __resetForTests as resetLifecycle,
  track,
} from '../../lifecycle.ts';
import { snapshot } from '../../network/health.ts';
import { readValue } from '../../storage.ts';
import * as sessions from '../session.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const MIN = 60_000;
const T0_SEC = T0 / 1000;

function experiment(id: number, extra: Partial<ProjectConfig['experiments'][number]> = {}) {
  return {
    experiment_id: id,
    status: 'active' as const,
    traffic_allocation: 100,
    rules: [],
    variations: [{ variation_id: id * 10, weight: 100, changes: [] }],
    goals: [],
    platform_version: 'v2' as const,
    ...extra,
  };
}

function project(experiments: ProjectConfig['experiments']): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments,
    published_at: '2026-10-01T00:00:00.000Z',
    config_hash: 'abc',
  };
}

function boot(p: ProjectConfig): void {
  window.cfPrefill = { project: p };
  installQueue();
  hydrate();
}

const sent = (): PixelEvent[] =>
  __getPendingEventsForTests()
    .map((e) => e.event)
    .filter((e): e is PixelEvent => e !== undefined);
const named = (name: string) => sent().filter((e) => e.event_name === name);

beforeEach(async () => {
  await resetPixelState();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  await resetPixelState();
});

describe('sliding 60-minute session (unit)', () => {
  beforeEach(() => {
    cookies.setAssignment(17, 170);
  });

  it('59 min idle keeps the session, 61 min expires it', () => {
    sessions.ensureSession(17, 170, T0);
    expect(sessions.activeExp([17], T0 + 59 * MIN)).toEqual([[17, 170, T0_SEC, 1]]);
    expect(sessions.activeExp([17], T0 + 61 * MIN)).toEqual([]);
  });

  it('70 minutes of continuous activity stays in the same session', () => {
    sessions.ensureSession(17, 170, T0);
    for (let m = 10; m <= 70; m += 10) {
      const exp = sessions.activeExp([17], T0 + m * MIN);
      expect(exp).toEqual([[17, 170, T0_SEC, 1]]);
      sessions.touch(exp, T0 + m * MIN);
    }
    expect(sessions.activeExp([17], T0 + 125 * MIN)).toHaveLength(1);
  });

  it('a new session after expiry increments sessionIdx', () => {
    sessions.ensureSession(17, 170, T0);
    const { started, session } = sessions.ensureSession(17, 170, T0 + 2 * 24 * 60 * MIN);
    expect(started).toBe(true);
    expect(session.sessionIdx).toBe(2);
    expect(sessions.ensureSession(17, 170, T0 + 2 * 24 * 60 * MIN + MIN).started).toBe(false);
  });

  it('legacy millisecond sessionExp is read as last-touch + 1 h', () => {
    expect(sessions.normalizeExpiry(T0)).toBe(T0_SEC + 3600);
    expect(sessions.normalizeExpiry(T0_SEC + 5)).toBe(T0_SEC + 5);
  });
});

describe('pixel lifecycle on the v2 pipeline', () => {
  it('experiment_view starts session 1; page_view fires after it inside the session', () => {
    boot(project([experiment(17)]));
    const names = sent().map((e) => e.event_name);
    expect(names.indexOf('experiment_view')).toBeLessThan(names.indexOf('page_view'));
    const want: ExpSession[] = [[17, 170, T0_SEC, 1]];
    for (const e of sent()) {
      expect(e.exp).toEqual(want);
      expect(e.in_experiment).toBe(1);
    }
  });

  it('two experiments, only one with an active session → one exp tuple', () => {
    boot(project([experiment(17), experiment(18, { traffic_allocation: 0 })]));
    track('add_to_cart', { value_native: 10, currency: 'EUR' });
    expect(named('add_to_cart')[0]?.exp).toEqual([[17, 170, T0_SEC, 1]]);
  });

  it('events with no active session are dropped and counted', () => {
    boot(project([experiment(17)]));
    vi.setSystemTime(T0 + 61 * MIN);
    __clearPendingEventsForTests();
    track('add_to_cart');
    track('size_guide_opened');
    expect(sent()).toEqual([]);
    expect(snapshot(0).dropped_no_session).toBe(2);
  });

  it('a returning visitor after 2 days: same variation, new sessionStart, sessionIdx 2, experiment_view fired', () => {
    boot(project([experiment(17)]));
    resetLifecycle();
    sessions.__resetForTests();
    __clearPendingEventsForTests();
    const later = T0 + 2 * 24 * 60 * MIN;
    vi.setSystemTime(later);
    boot(project([experiment(17)]));
    const view = named('experiment_view')[0];
    expect(view?.variation_id).toBe(170);
    expect(view?.exp).toEqual([[17, 170, later / 1000, 2]]);
    track('purchase', { order_id: 'O1', value_native: 80, currency: 'EUR' });
    expect(named('purchase')[0]?.exp).toEqual([[17, 170, later / 1000, 2]]);
    // Persisted for @testa-soft/next (6-field packed segment).
    expect(parsePacked(readValue(cookies.ASSIGNMENT_COOKIE)).get(17)).toMatchObject({
      sessionStart: later / 1000,
      sessionIdx: 2,
    });
  });

  it('an old 4-field cookie parses: assignment kept, session 1 starts', () => {
    document.cookie = `${cookies.ASSIGNMENT_COOKIE}=17.170.0.1720450000; path=/`;
    boot(
      project([
        experiment(17, {
          variations: [
            { variation_id: 170, weight: 50, changes: [] },
            { variation_id: 171, weight: 50, changes: [] },
          ],
        }),
      ]),
    );
    expect(named('experiment_view')[0]?.exp).toEqual([[17, 170, T0_SEC, 1]]);
  });

  it('re-init on a non-matching page keeps the session but fires no experiment_view', () => {
    boot(
      project([experiment(17, { rules: [{ match_type: 'contains', url_pattern: '/only-here' }] })]),
    );
    expect(named('experiment_view')).toEqual([]);
    expect(named('page_view')[0]?.exp).toEqual([[17, 170, T0_SEC, 1]]);
  });

  it('v1 experiments in a v2 project: no experiment_view and not in exp', () => {
    boot(project([experiment(17), experiment(18, { platform_version: 'v1' })]));
    const views = named('experiment_view').map((e) => e.experiment_id);
    expect(views).toEqual([17]);
    expect(named('page_view')[0]?.exp).toEqual([[17, 170, T0_SEC, 1]]);
  });

  it('cookie writes are throttled to one per 30 s (in-memory copy authoritative) and flushed on pagehide', () => {
    boot(project([experiment(17)]));
    const read = () => parsePacked(readValue(cookies.ASSIGNMENT_COOKIE)).get(17)?.sessionExp;
    expect(read()).toBe(T0_SEC + 3600);
    vi.setSystemTime(T0 + 10_000);
    track('add_to_cart');
    expect(read()).toBe(T0_SEC + 3600); // throttled
    expect(named('add_to_cart')[0]?.exp).toEqual([[17, 170, T0_SEC, 1]]);
    dispatchEvent(new Event('pagehide'));
    expect(read()).toBe(T0_SEC + 10 + 3600);
  });
});

describe('v1-only project (regression: unchanged)', () => {
  it('no exp, no in_experiment, nothing dropped, page_view before experiment_view', () => {
    const { platform_version: _v, ...v1 } = experiment(17);
    boot(project([v1]));
    const names = sent().map((e) => e.event_name);
    expect(names.indexOf('page_view')).toBeLessThan(names.indexOf('experiment_view'));
    for (const e of sent()) {
      expect(e.exp).toEqual([]);
      expect('in_experiment' in e).toBe(false);
    }
    vi.setSystemTime(T0 + 5 * 60 * MIN);
    track('add_to_cart');
    expect(named('add_to_cart')).toHaveLength(1);
    expect(snapshot(0).dropped_no_session).toBe(0);
    // The legacy session bump (ms) is untouched.
    expect(parsePacked(readValue(cookies.ASSIGNMENT_COOKIE)).get(17)?.sessionExp).toBe(T0);
  });
});
