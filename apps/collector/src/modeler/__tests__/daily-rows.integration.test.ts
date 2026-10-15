/**
 * Daily rows builder (task 5.9) against a real ClickHouse: F1 golden exact,
 * demo goldens (core, device_type, visitor_type, capped), FX previous-day
 * rule, returning-visitor re-sorting, dimension additivity.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p4 bun test src/modeler
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type {
  DailyRow,
  DimensionRow,
  ExperimentConfig,
  MetricKey,
  SummaryResult,
} from '@testa-platform/shared-types';
import { views } from '../../analytics/views.ts';
import { insertRows } from '../../db/clickhouse.ts';
import { type DailyRowsParams, computeDailyRows } from '../daily-rows.ts';
import '../summary-view.ts';
import {
  database,
  live,
  prepareDatabase,
  randomProjectId,
  readGolden,
  run,
  seedFx,
  seedOracleFx,
  seedSample,
} from './live.ts';

const F1 = readGolden<SummaryResult>('f1', 'daily_summary.json');
const KEYS = [...new Set(F1.rows.map((r) => r.metric_key))] as MetricKey[];

const rowId = (r: DailyRow | DimensionRow): string =>
  `${r.date}|${r.variation_id}|${'dimension_value' in r ? r.dimension_value : ''}|${r.metric_key}`;
const byId = <T extends DailyRow>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((r) => [rowId(r), r]));

/** Exact comparison, order-insensitive. */
function expectSameRows(actual: readonly DailyRow[], expected: readonly DailyRow[]): void {
  const sort = (rows: readonly DailyRow[]) =>
    [...rows].sort((a, b) => rowId(a).localeCompare(rowId(b)));
  expect(sort(actual)).toEqual(sort(expected));
}

/** Sum rows over dates (and dimension values) per variation × key. */
interface Totals {
  visitors: number;
  converted: number;
  count: number;
  sum: number;
}
const ZERO_TOTALS: Totals = { visitors: 0, converted: 0, count: 0, sum: 0 };

function totals(rows: readonly DailyRow[]): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const r of rows) {
    const id = `${r.variation_id}|${r.metric_key}`;
    const cur = out.get(id) ?? ZERO_TOTALS;
    out.set(id, {
      visitors: cur.visitors + r.visitors,
      converted: cur.converted + r.converted,
      count: cur.count + r.count,
      sum: cur.sum + r.sum,
    });
  }
  return out;
}

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

describe.skipIf(!live)(`daily rows builder (live ClickHouse, db=${database})`, () => {
  const f1Project = randomProjectId();
  const demoProject = randomProjectId();
  const f1: DailyRowsParams = {
    projectId: f1Project,
    experimentId: 1717,
    from: '2026-10-01',
    to: '2026-10-03',
    reportCurrency: 'EUR',
    metrics: KEYS,
    variationOrder: [100, 101],
  };
  const demo: DailyRowsParams = {
    ...f1,
    projectId: demoProject,
    to: '2026-10-14',
    variationOrder: [100, 101, 102],
  };

  beforeAll(async () => {
    await prepareDatabase();
    await seedOracleFx('2026-10-01', '2026-10-15');
    await Promise.all([seedSample('f1', f1Project), seedSample('demo', demoProject)]);
  });

  it('F1: rows equal the golden exactly; quality matches', async () => {
    const result = await computeDailyRows(run, f1);
    expect(result.dimension).toBeNull();
    expectSameRows(result.rows, F1.rows);
    expect(result.quality).toEqual(F1.quality);
  });

  it('summary view: registered, validate + run return the F1 golden as a SummaryResult', async () => {
    const view = views.get('summary');
    const params = view.validate({ from: f1.from, to: f1.to, metrics: KEYS });
    const result = await view.run(
      {
        projectId: f1Project,
        experimentId: 1717,
        experiment: {
          variations: [{ variation_id: 100 }, { variation_id: 101 }],
        } as ExperimentConfig,
        reportCurrency: 'EUR',
        query: run,
      },
      params,
    );
    const { rows, ...meta } = result as SummaryResult;
    const { rows: goldenRows, ...goldenMeta } = F1;
    expect(meta).toEqual(goldenMeta);
    expectSameRows(rows, goldenRows);
  });

  it('F1: summed rows reproduce CR / AOV / RPV (006-validation.md)', async () => {
    const { rows } = await computeDailyRows(run, { ...f1, metrics: ['purchase', 'revenue'] });
    const t = totals(rows);
    const at = (v: number, k: string): Totals => t.get(`${v}|${k}`) ?? ZERO_TOTALS;
    const expected = {
      100: { cr: 1 / 3, aov: 100, rpv: 100 / 3 },
      101: { cr: 2 / 3, aov: 62.5, rpv: 145 / 3 },
    };
    for (const [v, e] of Object.entries(expected)) {
      const p = at(Number(v), 'purchase');
      const revenue = at(Number(v), 'revenue').sum;
      expect(close(p.converted / p.visitors, e.cr)).toBe(true);
      expect(close(p.sum / p.count, e.aov)).toBe(true);
      expect(close(revenue / p.visitors, e.rpv)).toBe(true);
    }
  });

  it('FX: the USD order converts (O2 $50 → €45 in purchase.sum)', async () => {
    const { rows } = await computeDailyRows(run, { ...f1, metrics: ['purchase'] });
    const d1v101 = rows.find((r) => r.date === '2026-10-01' && r.variation_id === 101);
    expect(d1v101?.sum).toBe(125); // 45 (O2) + 80 (O3, credited to D1)
  });

  for (const [file, extra] of [
    ['daily_summary.json', {}],
    ['daily_summary.device_type.json', { dimension: 'device_type' }],
    ['daily_summary.visitor_type.json', { dimension: 'visitor_type' }],
    ['daily_summary.capped.json', { capOutliers: true, metrics: ['purchase', 'revenue'] }],
  ] as const) {
    it(`demo: ${file} matches the golden`, async () => {
      const golden = readGolden<SummaryResult>('demo', file);
      const metrics = [...new Set(golden.rows.map((r) => r.metric_key))] as MetricKey[];
      const result = await computeDailyRows(run, { ...demo, metrics, ...extra });
      expect(result.quality).toEqual(golden.quality);
      const want = byId(golden.rows as DailyRow[]);
      const got = byId(result.rows as DailyRow[]);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [id, w] of want) {
        const g = got.get(id) as DailyRow;
        expect({ id, ...g, sum: 0, sum_sq: 0, sum_sq_visitor: 0 }).toEqual({
          id,
          ...w,
          sum: 0,
          sum_sq: 0,
          sum_sq_visitor: 0,
        });
        // Float summation order differs from the oracle: allow one cent of rounding drift.
        for (const f of ['sum', 'sum_sq', 'sum_sq_visitor'] as const) {
          expect(Math.abs(g[f] - w[f])).toBeLessThanOrEqual(0.011);
        }
      }
    }, 30_000);
  }

  it('dimension rows sum to the core rows (visitors, converted, count, sum)', async () => {
    const core = totals((await computeDailyRows(run, demo)).rows);
    for (const dimension of ['device_type', 'visitor_type', 'country', 'channel'] as const) {
      const split = totals((await computeDailyRows(run, { ...demo, dimension })).rows);
      for (const [id, c] of core) {
        const s = split.get(id) ?? ZERO_TOTALS;
        expect([s.visitors, s.converted, s.count]).toEqual([c.visitors, c.converted, c.count]);
        expect(close(s.sum, c.sum, 0.05)).toBe(true);
      }
    }
  }, 60_000);

  it('payment_type split: only add_payment_info + purchase, post_exposure rows', async () => {
    const result = await computeDailyRows(run, {
      ...f1,
      metrics: ['add_payment_info', 'purchase'],
      dimension: 'payment_type',
    });
    expect(result.dimension).toBe('payment_type');
    const values = new Set((result.rows as DimensionRow[]).map((r) => r.dimension_value));
    expect(values).toEqual(new Set(['card', 'paypal', '(none)']));
    expect((result.rows as DimensionRow[]).every((r) => r.post_exposure === true)).toBe(true);
    await expect(
      computeDailyRows(run, { ...f1, metrics: ['add_to_cart'], dimension: 'payment_type' }),
    ).rejects.toMatchObject({ code: 'unknown_metric', status: 400 });
  });

  it('a returning visitor (session_idx 2) moves to returning with all events; totals unchanged', async () => {
    const projectId = randomProjectId();
    const visitor = `a-${randomUUID()}`;
    const ev = (name: string, ts: string, idx: number, start: number, extra: object = {}) => ({
      event_id: randomUUID(),
      client_ts: ts,
      server_ts: ts,
      project_id: projectId,
      visitor_id: visitor,
      session_id: `s${idx}`,
      event_name: name,
      url: 'https://shop.example/',
      exp_ids: [1717],
      exp_var_ids: [100],
      exp_session_starts: [start],
      exp_session_idx: [idx],
      ...extra,
    });
    const scope: DailyRowsParams = {
      ...f1,
      projectId,
      metrics: ['generate_lead', 'purchase'],
      dimension: 'visitor_type',
    };
    const oct1 = 1_790_848_800; // 2026-10-01 10:00:00 UTC
    await insertRows('events', [
      ev('experiment_view', '2026-10-01 10:00:00.000', 1, oct1, {
        experiment_id: 1717,
        variation_id: 100,
      }),
      ev('generate_lead', '2026-10-01 10:05:00.000', 1, oct1),
    ]);
    const before = (await computeDailyRows(run, scope)).rows as DimensionRow[];
    expect(new Set(before.map((r) => r.dimension_value))).toEqual(new Set(['new']));

    const oct3 = oct1 + 2 * 86_400;
    await insertRows('events', [
      ev('experiment_view', '2026-10-03 10:00:00.000', 2, oct3, {
        experiment_id: 1717,
        variation_id: 100,
      }),
      ev('purchase', '2026-10-03 10:10:00.000', 2, oct3, {
        order_id: `o-${visitor}`,
        purchase_type: 'initial',
        value_native: 80,
        currency: 'EUR',
      }),
    ]);
    const after = (await computeDailyRows(run, scope)).rows as DimensionRow[];
    expect(
      after.map((r) => [r.date, r.dimension_value, r.metric_key, r.visitors, r.converted, r.sum]),
    ).toEqual([
      ['2026-10-01', 'returning', 'generate_lead', 1, 1, 0],
      ['2026-10-01', 'returning', 'purchase', 1, 1, 80],
    ]);
  });

  it('FX uses the previous UTC day rate, falling back to the last known rate', async () => {
    const projectId = randomProjectId();
    // Dates no other fixture uses: rate(USD→EUR) 0.80 on Nov 9, 0.95 on Nov 10.
    await seedFx([
      { date: '2026-11-09', to_ccy: 'EUR', rate: 0.8 },
      { date: '2026-11-09', to_ccy: 'USD', rate: 1 },
      { date: '2026-11-10', to_ccy: 'EUR', rate: 0.95 },
      { date: '2026-11-10', to_ccy: 'USD', rate: 1 },
    ]);
    const base = {
      project_id: projectId,
      visitor_id: 'fx-v',
      session_id: 's',
      url: 'https://shop.example/',
      exp_ids: [1717],
      exp_var_ids: [100],
      exp_session_starts: [1],
    };
    await insertRows('events', [
      {
        ...base,
        event_id: randomUUID(),
        event_name: 'experiment_view',
        client_ts: '2026-11-10 08:00:00.000',
        experiment_id: 1717,
        variation_id: 100,
      },
      // Nov 10 order → Nov 9 rate (0.8); Nov 12 order → Nov 11 missing → last known (Nov 10, 0.95).
      {
        ...base,
        event_id: randomUUID(),
        event_name: 'purchase',
        client_ts: '2026-11-10 09:00:00.000',
        order_id: 'fx-1',
        purchase_type: 'initial',
        value_native: 100,
        currency: 'USD',
      },
      {
        ...base,
        event_id: randomUUID(),
        event_name: 'purchase',
        client_ts: '2026-11-12 09:00:00.000',
        order_id: 'fx-2',
        purchase_type: 'initial',
        value_native: 100,
        currency: 'USD',
      },
    ]);
    const { rows } = await computeDailyRows(run, {
      ...f1,
      projectId,
      from: '2026-11-10',
      to: '2026-11-12',
      metrics: ['purchase'],
    });
    expect(rows.map((r) => [r.count, r.sum, r.sum_sq])).toEqual([[2, 175, 15_425]]);
  });
});
