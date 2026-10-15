// @vitest-environment happy-dom
/**
 * `@testa-soft/next` PRD-006 tracking (task 5.7): typed helpers post
 * pixel-format events stamped with `exp` from the packed cookie; the provider
 * wiring re-inits sessions and fires experiment_view on variation_applied.
 * v2 experiments only.
 */
import type { PixelEvent, ProjectConfig } from '@testa-platform/shared-types';
import { emitVariationApplied } from '@testa-soft/dom';
import { ASSIGNMENT_COOKIE, parsePacked } from '@testa-soft/experiment-core';
import { DocumentCookieStore, startPrd006Tracking } from '@testa-soft/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { track, trackAddToCart, trackPaymentInfo, trackPurchase } from '../index.ts';

const T0 = Date.parse('2026-10-01T10:00:00Z');
const T0_SEC = T0 / 1000;
let nextId = 9000;

function config(
  expId: number,
  version?: 'v1' | 'v2',
  rules: ProjectConfig['experiments'][number]['rules'] = [],
): ProjectConfig {
  return {
    project_id: 42,
    slug: 'demo',
    integration_version: '4.0',
    consent_mode: 'aware',
    experiments: [
      {
        experiment_id: expId,
        status: 'active',
        traffic_allocation: 100,
        rules,
        variations: [{ variation_id: 1, weight: 100, changes: [] }],
        goals: [],
        ...(version ? { platform_version: version } : {}),
      },
    ],
    published_at: '',
    config_hash: String(expId),
  };
}

function clearCookies(): void {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; max-age=0; path=/`;
  }
}

let sent: PixelEvent[] = [];
let stop: () => void = () => undefined;

function start(cfg: ProjectConfig, cookie: string): DocumentCookieStore {
  document.cookie = `${ASSIGNMENT_COOKIE}=${cookie}; path=/`;
  const store = new DocumentCookieStore({ secure: false, mirrorToStorage: false });
  stop = startPrd006Tracking({ config: cfg, store, send: (events) => sent.push(...events) });
  return store;
}

const named = (n: string) => sent.filter((e) => e.event_name === n);

beforeEach(() => {
  clearCookies();
  sent = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('@testa-soft/next track (v2)', () => {
  it('re-inits the session, fires experiment_view on variation_applied, stamps exp on helpers', () => {
    const id = nextId++;
    const store = start(config(id, 'v2'), `${id}.1.0.0`);
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(id)).toMatchObject({
      sessionStart: T0_SEC,
      sessionIdx: 1,
      sessionExp: T0_SEC + 3600,
    });

    emitVariationApplied({
      project_id: 42,
      experiment: id,
      variation: 1,
      uuid: 'u',
      url: location.href,
    });
    expect(named('experiment_view')[0]).toMatchObject({
      experiment_id: id,
      variation_id: 1,
      exp: [[id, 1, T0_SEC, 1]],
      in_experiment: 1,
    });

    trackPurchase({
      order_id: 'O-1',
      currency: 'EUR',
      items: [{ item_id: 'A', price: 50, quantity: 2 }],
      coupon: 'X',
      payment_type: 'card',
    });
    expect(named('purchase')[0]).toMatchObject({
      order_id: 'O-1',
      purchase_type: 'initial',
      value_native: 100,
      currency: 'EUR',
      items: [{ item_id: 'A', price: 50, quantity: 2 }],
      items_count: 2,
      props: { coupon: 'X', payment_type: 'card' },
      exp: [[id, 1, T0_SEC, 1]],
      project_id: 42,
    });
  });

  it('sends slide the session; after 61 idle minutes events are dropped; a return starts session 2', () => {
    const id = nextId++;
    const cfg = config(id, 'v2');
    const store = start(cfg, `${id}.1.0.0`);
    vi.setSystemTime(T0 + 50 * 60_000);
    trackAddToCart([{ item_id: 'A', price: 1 }], { currency: 'EUR' });
    expect(parsePacked(store.get(ASSIGNMENT_COOKIE)).get(id)?.sessionExp).toBe(
      T0_SEC + 50 * 60 + 3600,
    );

    vi.setSystemTime(T0 + (50 + 61) * 60_000);
    track('size_guide_opened');
    expect(named('size_guide_opened')).toEqual([]);

    stop();
    vi.setSystemTime(T0 + 2 * 86_400_000);
    start(cfg, store.get(ASSIGNMENT_COOKIE) ?? '');
    track('page_view');
    expect(named('page_view')[0]?.exp).toEqual([[id, 1, T0_SEC + 2 * 86_400, 2]]);
  });

  it('invalid helper input never throws and sends nothing', () => {
    const id = nextId++;
    start(config(id, 'v2'), `${id}.1.0.0`);
    expect(() => trackPaymentInfo({} as never)).not.toThrow();
    expect(named('add_payment_info')).toEqual([]);
  });

  it('experiment_view only on a page the experiment runs on', () => {
    const id = nextId++;
    start(config(id, 'v2', [{ match_type: 'contains', url_pattern: '/elsewhere' }]), `${id}.1.0.0`);
    emitVariationApplied({
      project_id: 42,
      experiment: id,
      variation: 1,
      uuid: 'u',
      url: location.href,
    });
    expect(named('experiment_view')).toEqual([]);
  });
});

describe('v1 projects send nothing from the SDK tracker', () => {
  it('no session fields written, no events', () => {
    const id = nextId++;
    const store = start(config(id, 'v1'), `${id}.1.0.0`);
    emitVariationApplied({
      project_id: 42,
      experiment: id,
      variation: 1,
      uuid: 'u',
      url: location.href,
    });
    track('add_to_cart');
    expect(sent).toEqual([]);
    expect(store.get(ASSIGNMENT_COOKIE)).toBe(`${id}.1.0.0`);
  });
});
