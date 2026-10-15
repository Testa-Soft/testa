/**
 * The TS oracle must reproduce generate.py's committed goldens exactly
 * (docs/reference/samples/{f1,demo}/modeled), plus the hand-computed F1 values
 * from docs/prds/006-validation.md.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DailySummaryRow, Model } from '../oracle.ts';
import {
  SUMMARY_KEYS,
  buildModel,
  dailySummary,
  distributions,
  health,
  products,
  pyRound,
  srm,
} from '../oracle.ts';
import { loadSampleSim } from '../raw.ts';

const SAMPLES = resolve(import.meta.dir, '../../../../docs/reference/samples');
const EXP = 1717;
/** Upper bound on thank-you reload duplicates in the demo set (≈4% of orders). */
const MAX_DEMO_RELOAD_DUPS = 12;

function golden(set: 'f1' | 'demo', file: string): unknown {
  return JSON.parse(readFileSync(join(SAMPLES, set, 'modeled', file), 'utf8'));
}

interface HealthEvent {
  readonly event_name: string;
  readonly events: Record<string, number>;
  readonly [k: string]: unknown;
}
interface HealthDoc {
  readonly events: readonly HealthEvent[];
  readonly [k: string]: unknown;
}

interface Param {
  readonly param: string;
  readonly required: boolean;
  readonly present_pct: number | null;
}

/**
 * Demo purchase params over RAW events (reload duplicates included). The golden
 * (deduped) values are 0.966667 / 0.957806; the deduped basis is asserted
 * exactly in the "port check" test.
 */
const RAW_PURCHASE_PCT: Readonly<Record<string, number>> = {
  value_native: 0.967581,
  'items[].price': 0.956879,
};

function sumRows(rows: readonly DailySummaryRow[], variation: number, key: string) {
  const rs = rows.filter((r) => r.variation_id === variation && r.metric_key === key);
  return {
    visitors: rs.reduce((a, r) => a + r.visitors, 0),
    converted: rs.reduce((a, r) => a + r.converted, 0),
    count: rs.reduce((a, r) => a + r.count, 0),
    sum: rs.reduce((a, r) => a + r.sum, 0),
  };
}

describe('pyRound matches Python round()', () => {
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    [0.125, 2, 0.12],
    [0.375, 2, 0.38],
    [2.675, 2, 2.67],
    [2.5, 0, 2],
    [3.5, 0, 4],
    [-0.125, 2, -0.12],
    [1 / 3, 6, 0.333333],
    [2 / 3, 6, 0.666667],
    [100 / 3, 6, 33.333333],
    [0.3333333333, 4, 0.3333],
    [1.005, 2, 1.0],
    [10000, 2, 10000],
    [0.0625, 3, 0.062],
    [9.995, 2, 9.99],
  ];
  for (const [x, nd, want] of cases) {
    test(`round(${x}, ${nd}) = ${want}`, () => {
      expect(pyRound(x, nd)).toBe(want);
    });
  }
});

describe('F1 fixture', () => {
  let m: Model;
  beforeAll(() => {
    m = buildModel(
      loadSampleSim(SAMPLES, 'f1'),
      EXP,
      '2026-10-01',
      '2026-10-03',
      [100, 101],
      [0.5, 0.5],
    );
  });

  test('daily_summary.json', () => {
    expect(dailySummary(m)).toEqual(golden('f1', 'daily_summary.json') as never);
  });

  test('custom keys: goal:12 + event:size_guide_opened match the golden rows', () => {
    const keys = ['goal:12', 'event:size_guide_opened'];
    const rows = (golden('f1', 'daily_summary.json') as { rows: DailySummaryRow[] }).rows;
    // Golden order is (date, variation, key index); re-rank keys by the custom list.
    const groupRank = (r: DailySummaryRow) =>
      rows.findIndex((g) => g.date === r.date && g.variation_id === r.variation_id);
    const want = rows
      .filter((r) => keys.includes(r.metric_key))
      .sort(
        (a, b) =>
          groupRank(a) - groupRank(b) || keys.indexOf(a.metric_key) - keys.indexOf(b.metric_key),
      );
    expect(dailySummary(m, { keys }).rows).toEqual(want);
  });

  test('products.json', () => {
    expect(products(m)).toEqual(golden('f1', 'products.json') as never);
  });

  test('distributions.json', () => {
    expect(distributions(m)).toEqual(golden('f1', 'distributions.json') as never);
  });

  test('health over the deduped events reproduces health.json exactly (port check)', () => {
    expect(health({ ...m, attRaw: m.att })).toEqual(golden('f1', 'health.json') as never);
  });

  test('health.json, except purchase counts the O1 reload duplicate', () => {
    const want = structuredClone(golden('f1', 'health.json')) as HealthDoc;
    const purchase = want.events.find((e) => e.event_name === 'purchase');
    expect(purchase?.events['100']).toBe(1);
    if (purchase) purchase.events['100'] = 2; // documented deviation: raw, not deduped
    expect(health(m)).toEqual(want as never);
  });

  test('hand-computed values (006-validation.md, summed over D1–D3)', () => {
    const rows = dailySummary(m).rows;
    const expected = {
      100: { visitors: 3, purchasers: 1, orders: 1, revenue: 100.0, cr: 1 / 3, aov: 100.0 },
      101: { visitors: 3, purchasers: 2, orders: 2, revenue: 145.0, cr: 2 / 3, aov: 62.5 },
    } as const;
    const rpv = { 100: 33.333333, 101: 48.333333 } as const;
    for (const v of [100, 101] as const) {
      const p = sumRows(rows, v, 'purchase');
      const rev = sumRows(rows, v, 'revenue');
      const ex = expected[v];
      expect(p.visitors).toBe(ex.visitors);
      expect(p.converted).toBe(ex.purchasers);
      expect(p.count).toBe(ex.orders);
      expect(Math.abs(rev.sum - ex.revenue)).toBeLessThan(1e-6);
      expect(Math.abs(p.converted / p.visitors - ex.cr)).toBeLessThan(1e-6);
      expect(Math.abs(p.sum / p.count - ex.aov)).toBeLessThan(1e-6);
      expect(Math.abs(rev.sum / p.visitors - rpv[v])).toBeLessThan(1e-6);
    }
  });
});

describe('demo dataset', () => {
  let m: Model;
  beforeAll(() => {
    m = buildModel(
      loadSampleSim(SAMPLES, 'demo'),
      EXP,
      '2026-10-01',
      '2026-10-14',
      [100, 101, 102],
      [1 / 3, 1 / 3, 1 / 3],
    );
  });

  test('daily_summary.json', () => {
    expect(dailySummary(m)).toEqual(golden('demo', 'daily_summary.json') as never);
  });

  test('daily_summary.device_type.json', () => {
    expect(dailySummary(m, { dimension: 'device_type' })).toEqual(
      golden('demo', 'daily_summary.device_type.json') as never,
    );
  });

  test('daily_summary.visitor_type.json', () => {
    expect(dailySummary(m, { dimension: 'visitor_type' })).toEqual(
      golden('demo', 'daily_summary.visitor_type.json') as never,
    );
  });

  test('daily_summary.capped.json', () => {
    expect(dailySummary(m, { keys: ['purchase', 'revenue'], capped: true })).toEqual(
      golden('demo', 'daily_summary.capped.json') as never,
    );
  });

  test('products.json and products.upsell.json', () => {
    expect(products(m)).toEqual(golden('demo', 'products.json') as never);
    expect(products(m, { purchaseType: 'upsell' })).toEqual(
      golden('demo', 'products.upsell.json') as never,
    );
  });

  test('distributions.json', () => {
    expect(distributions(m)).toEqual(golden('demo', 'distributions.json') as never);
  });

  test('srm matches the golden block', () => {
    expect(srm(m)).toEqual((golden('demo', 'health.json') as HealthDoc).srm as never);
  });

  test('health over the deduped events reproduces health.json exactly (port check)', () => {
    expect(health({ ...m, attRaw: m.att })).toEqual(golden('demo', 'health.json') as never);
  });

  test('health.json: purchase events include reload duplicates, all else exact', () => {
    const want = golden('demo', 'health.json') as HealthDoc;
    const got = health(m) as unknown as HealthDoc;
    const { events: wantEvents, ...wantRest } = want;
    const { events: gotEvents, ...gotRest } = got;
    expect(gotRest).toEqual(wantRest);
    expect(gotEvents.map((e) => e.event_name)).toEqual(wantEvents.map((e) => e.event_name));
    let extra = 0;
    wantEvents.forEach((w, i) => {
      const g = gotEvents[i];
      if (!g) throw new Error(`missing health event ${w.event_name}`);
      if (w.event_name !== 'purchase') {
        expect(g).toEqual(w);
        return;
      }
      const { events: gEv, params: gParams, ...gRest } = g;
      const { events: wEv, params: wParams, ...wRest } = w;
      expect(gRest).toEqual(wRest);
      // Duplicated rows shift the two params that are not 100% present.
      const raw = (gParams as Param[]).map((p) =>
        p.param in RAW_PURCHASE_PCT ? { ...p, present_pct: RAW_PURCHASE_PCT[p.param] } : p,
      );
      expect(raw).toEqual(gParams as Param[]);
      expect((wParams as Param[]).map((p) => p.param)).toEqual(raw.map((p) => p.param));
      (wParams as Param[]).forEach((p, j) => {
        if (!(p.param in RAW_PURCHASE_PCT)) expect(raw[j]).toEqual(p);
      });
      for (const [v, n] of Object.entries(wEv)) {
        const got = gEv[v] ?? 0;
        expect(got).toBeGreaterThanOrEqual(n);
        extra += got - n;
      }
    });
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThanOrEqual(MAX_DEMO_RELOAD_DUPS);
  });

  test('SUMMARY_KEYS keeps the oracle order', () => {
    expect(SUMMARY_KEYS[0]).toBe('purchase');
    expect(SUMMARY_KEYS.at(-1)).toBe('goal:12');
    expect(SUMMARY_KEYS).toHaveLength(23);
  });
});
