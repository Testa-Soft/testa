/** `buildHealth` (task 5.17): status thresholds, coverage, metric availability, SRM. */
import { describe, expect, it } from 'bun:test';
import { type HealthInput, buildHealth } from '../build.ts';
import type { EventRow, HealthRows } from '../query.ts';

const NONE = {
  order_id: 0,
  value_native: 0,
  currency: 0,
  purchase_type: 0,
  payment_type: 0,
  items: 0,
};

const row = (event_name: string, variation_id: number, events: number, extra = {}): EventRow => ({
  event_name,
  variation_id,
  events,
  visitors: events,
  last_event_at: `2026-10-0${variation_id % 9} 10:00:00.000`,
  present: { ...NONE, ...extra },
});

const input = (rows: Partial<HealthRows>, variations = [100, 101]): HealthInput => ({
  experimentId: 1,
  from: '2026-10-01',
  to: '2026-10-03',
  variations: variations.map((id) => ({ id, weight: 1 })),
  rows: { events: [], items: [], exposed: [], ...rows },
});

describe('events', () => {
  it('95% present is ok, just below is a warning', () => {
    const ok = buildHealth(
      input({ events: [row('add_payment_info', 100, 100, { payment_type: 95 })] }),
    );
    expect(ok.events.find((e) => e.event_name === 'add_payment_info')?.status).toBe('ok');
    const warn = buildHealth(
      input({ events: [row('add_payment_info', 100, 1000, { payment_type: 949 })] }),
    );
    const apm = warn.events.find((e) => e.event_name === 'add_payment_info');
    expect(apm?.status).toBe('warning');
    expect(apm?.params).toEqual([{ param: 'payment_type', required: true, present_pct: 0.949 }]);
  });

  it('sums coverage over variations; last_event_at is the latest; zeros for silent variations', () => {
    const r = buildHealth(
      input(
        {
          events: [
            row('add_payment_info', 100, 2, { payment_type: 2 }),
            row('add_payment_info', 101, 2, { payment_type: 1 }),
          ],
        },
        [100, 101, 102],
      ),
    );
    const apm = r.events.find((e) => e.event_name === 'add_payment_info');
    expect(apm?.params[0]?.present_pct).toBe(0.75);
    expect(apm?.last_event_at).toBe('2026-10-02 10:00:00.000');
    expect(apm?.events).toEqual({ '100': 2, '101': 2, '102': 0 });
  });

  it('items[].* coverage comes from item rows', () => {
    const r = buildHealth(
      input({
        events: [row('add_to_cart', 100, 2, { items: 2 })],
        items: [
          { event_name: 'add_to_cart', items: 3, present: { item_id: 3, price: 1, quantity: 3 } },
        ],
      }),
    );
    const atc = r.events.find((e) => e.event_name === 'add_to_cart');
    expect(atc?.params.map((p) => p.present_pct)).toEqual([1, 1, 0.333333]);
    expect(atc?.status).toBe('warning');
  });

  it('a silent event is missing with null coverage; spec order is kept', () => {
    const r = buildHealth(input({}));
    expect(r.events.map((e) => e.event_name)).toEqual([
      'purchase',
      'add_to_cart',
      'add_payment_info',
      'begin_checkout',
      'add_shipping_info',
      'experiment_view',
      'page_view',
    ]);
    const purchase = r.events[0];
    expect(purchase?.status).toBe('missing');
    expect(purchase?.last_event_at).toBeNull();
    expect(purchase?.params.every((p) => p.present_pct === null)).toBe(true);
  });

  it('a variation in data but not in config is kept', () => {
    const r = buildHealth(input({ events: [row('page_view', 999, 4)] }));
    expect(r.events.find((e) => e.event_name === 'page_view')?.events).toEqual({
      '100': 0,
      '101': 0,
      '999': 4,
    });
  });
});

describe('metrics + summary', () => {
  it('missing → unavailable, warning → limited, with reasons', () => {
    const r = buildHealth(
      input({
        events: [
          row('purchase', 100, 10, {
            order_id: 10,
            value_native: 10,
            currency: 10,
            purchase_type: 10,
            items: 10,
          }),
          row('add_to_cart', 100, 10, { items: 5 }),
        ],
        items: [
          { event_name: 'purchase', items: 10, present: { item_id: 10, price: 10, quantity: 10 } },
          { event_name: 'add_to_cart', items: 5, present: { item_id: 5, price: 5, quantity: 5 } },
        ],
      }),
    );
    const by = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
    expect(by.cr).toEqual({ key: 'cr', availability: 'full', reason: '' });
    expect(by.buy_to_cart).toEqual({
      key: 'buy_to_cart',
      availability: 'limited',
      reason: 'add_to_cart: warning',
    });
    expect(by.step_payment_to_purchase).toEqual({
      key: 'step_payment_to_purchase',
      availability: 'unavailable',
      reason: 'add_payment_info: missing',
    });
    expect(r.summary).toEqual({
      events_receiving: 2,
      events_expected: 7,
      param_warnings: 1,
      metrics_full: 4,
      metrics_limited: 2,
    });
  });
});

describe('srm', () => {
  it('F3 counts, ⅓ each → χ² 0.8277, p 0.6611 (P3 srmChiSquare)', () => {
    const r = buildHealth(
      input(
        {
          exposed: [
            { variation_id: 100, visitors: 4737 },
            { variation_id: 101, visitors: 4790 },
            { variation_id: 102, visitors: 4702 },
          ],
        },
        [100, 101, 102],
      ),
    );
    expect(Math.abs(r.srm.chi2 - 0.8277)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(r.srm.p_value - 0.6611)).toBeLessThanOrEqual(0.001);
    expect(r.srm.ok).toBe(true);
    expect(r.srm.expected_weights['100']).toBeCloseTo(1 / 3, 10);
  });

  it('a strong imbalance fails (p < 0.001)', () => {
    const r = buildHealth(
      input({
        exposed: [
          { variation_id: 100, visitors: 1000 },
          { variation_id: 101, visitors: 800 },
        ],
      }),
    );
    expect(r.srm.ok).toBe(false);
  });

  it('no visitors or a single weighted variation → χ² 0, p 1', () => {
    expect(buildHealth(input({})).srm).toMatchObject({ chi2: 0, p_value: 1, ok: true });
    const single: HealthInput = {
      ...input({ exposed: [{ variation_id: 100, visitors: 5 }] }),
      variations: [
        { id: 100, weight: 1 },
        { id: 101, weight: 0 },
      ],
    };
    expect(buildHealth(single).srm).toEqual({
      chi2: 0,
      p_value: 1,
      ok: true,
      expected_weights: { '100': 1 },
    });
  });
});
