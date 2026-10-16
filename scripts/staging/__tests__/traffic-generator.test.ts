import { describe, expect, test } from 'bun:test';
import { type TrafficOptions, generateTraffic } from '../traffic-generator.ts';

const NOW = Date.parse('2026-10-16T12:00:00Z');

const opts = (over: Partial<TrafficOptions> = {}): TrafficOptions => ({
  projectId: 42,
  experimentId: 7,
  variations: [0, 1],
  visitorsPerVariation: 500,
  days: 14,
  nowMs: NOW,
  lift: { 1: 1.3 },
  seed: 1,
  domain: 'staging-shop.example',
  ...over,
});

const ms = (chTs: string) => Date.parse(`${chTs.replace(' ', 'T')}Z`);

describe('generateTraffic', () => {
  test('is deterministic for the same options', () => {
    const a = generateTraffic(opts());
    const b = generateTraffic(opts());
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.map((e) => e.event_id)).toEqual(b.events.map((e) => e.event_id));
  });

  test('exposes exactly N visitors per variation, each in one variation', () => {
    const { events } = generateTraffic(opts());
    const byVariation = new Map<number, Set<string>>();
    for (const e of events.filter((e) => e.event_name === 'experiment_view')) {
      const set = byVariation.get(e.variation_id as number) ?? new Set();
      set.add(e.visitor_id);
      byVariation.set(e.variation_id as number, set);
    }
    expect(byVariation.get(0)?.size).toBe(500);
    expect(byVariation.get(1)?.size).toBe(500);
    for (const v of byVariation.get(0) ?? []) expect(byVariation.get(1)?.has(v)).toBe(false);
  });

  test('stays inside the window and never in the future', () => {
    const { events } = generateTraffic(opts());
    const from = NOW - 14 * 86_400_000;
    for (const e of events) {
      expect(ms(e.client_ts)).toBeGreaterThanOrEqual(from);
      expect(ms(e.client_ts)).toBeLessThan(NOW);
    }
  });

  test('every event carries the experiment tuple of its visitor', () => {
    const { events } = generateTraffic(opts());
    for (const e of events) {
      expect(e.exp_ids).toEqual([7]);
      expect([0, 1]).toContain(e.exp_var_ids[0] as number);
      expect(e.project_id).toBe(42);
    }
  });

  test('the lift shows up in purchasers', () => {
    const { events } = generateTraffic(opts({ visitorsPerVariation: 5000 }));
    const buyers = (variation: number) =>
      new Set(
        events
          .filter((e) => e.event_name === 'purchase' && e.purchase_type === 'initial')
          .filter((e) => e.exp_var_ids[0] === variation)
          .map((e) => e.visitor_id),
      ).size;
    const ratio = buyers(1) / buyers(0);
    expect(ratio).toBeGreaterThan(1.15);
    expect(ratio).toBeLessThan(1.45);
  });

  test('purchases carry items, upsells point at their parent order', () => {
    const { events, items } = generateTraffic(opts());
    const purchases = events.filter((e) => e.event_name === 'purchase');
    expect(purchases.length).toBeGreaterThan(0);
    const withItems = new Set(items.map((i) => i.event_id));
    for (const p of purchases) expect(withItems.has(p.event_id)).toBe(true);
    for (const u of purchases.filter((p) => p.purchase_type === 'upsell'))
      expect(u.order_id).toBe(`${u.parent_order_id}-U1`);
  });

  test('rejects bad options', () => {
    expect(() => generateTraffic(opts({ variations: [0] }))).toThrow(RangeError);
    expect(() => generateTraffic(opts({ variations: [0, 0] }))).toThrow(RangeError);
    expect(() => generateTraffic(opts({ lift: { 9: 1.1 } }))).toThrow(RangeError);
    expect(() => generateTraffic(opts({ lift: { 1: 5 } }))).toThrow(RangeError);
    expect(() => generateTraffic(opts({ days: 0 }))).toThrow(RangeError);
  });
});
