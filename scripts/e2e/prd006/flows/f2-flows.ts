/**
 * F2 flows (006-validation.md V4, V6 and the F2 halves of V5, V12, V13): the
 * platform's rows and views against the TypeScript oracle computed from the
 * same in-memory generated events (counts exact, money ±0.01).
 */

import { deriveMetrics, sumByVariation } from '../../cross/lib/derive.ts';
import { FIXTURES } from '../config.ts';
import { F2_FROM, F2_TO } from '../fixtures/f2-generator.ts';
import { type Model, dailySummary, distributions, products } from '../oracle.ts';
import type { DailyRowLike, SummaryBody } from './api.ts';
import { type CheckFn, Diff, F2_KEYS, type FlowCtx, fact } from './types.ts';

const P = FIXTURES.F2.projectId;
const [EXP_A, EXP_B] = FIXTURES.F2.experiments;

interface RowShape {
  readonly date: string;
  readonly variation_id: number;
  readonly metric_key: string;
  readonly dimension_value?: unknown;
  readonly visitors: number;
  readonly converted: number;
  readonly count: number;
  readonly sum: number;
  readonly sum_sq: number;
  readonly sum_sq_visitor: number;
}

const keyOf = (r: RowShape) =>
  `${r.date}|${r.variation_id}|${String(r.dimension_value ?? '')}|${r.metric_key}`;
/** "money ±0.01": rounded sums may differ by one cent on half-cent ties (float order). */
const MONEY_TOL = 0.01 + 1e-6;
const moneyTol = (x: number) => Math.max(MONEY_TOL, Math.abs(x) * 1e-9);

/** Platform rows vs oracle rows: same set, counts exact, money ±0.01. */
export function compareRows(
  d: Diff,
  label: string,
  expected: readonly RowShape[],
  actual: readonly RowShape[],
): void {
  const got = new Map(actual.map((r) => [keyOf(r), r]));
  d.eq(`${label} row count`, expected.length, actual.length);
  for (const e of expected) {
    const r = got.get(keyOf(e));
    if (!r) {
      d.truthy(`${label} row ${keyOf(e)} present`, false);
      continue;
    }
    for (const f of ['visitors', 'converted', 'count'] as const)
      d.eq(`${label} ${keyOf(e)} ${f}`, e[f], r[f]);
    for (const f of ['sum', 'sum_sq', 'sum_sq_visitor'] as const)
      d.near(`${label} ${keyOf(e)} ${f}`, e[f], r[f], moneyTol(e[f]));
  }
}

const model = (ctx: FlowCtx, exp: number) => fact<Model>(ctx, `f2.model.${exp}`);
const summary = (ctx: FlowCtx, exp: number) => fact<SummaryBody>(ctx, `f2.summary.${exp}`);
const base = (exp: number) => ({
  project_id: P,
  from: F2_FROM,
  to: F2_TO,
  report_currency: 'EUR',
  _exp: exp,
});
const body = (exp: number, extra: Record<string, unknown>) => {
  const { _exp, ...rest } = base(exp);
  return { view: 'summary', ...rest, ...extra };
};

export async function v4(ctx: FlowCtx, check: CheckFn): Promise<void> {
  for (const exp of [EXP_A, EXP_B]) {
    await check(
      `experiment ${exp}: every §2.3 key + 3 event: + 3 goal: keys equal the oracle per date × variation`,
      async () => {
        const d = new Diff();
        compareRows(
          d,
          String(exp),
          dailySummary(model(ctx, exp), { keys: F2_KEYS }).rows,
          summary(ctx, exp).rows,
        );
        return d.outcome(`${summary(ctx, exp).rows.length} rows`);
      },
    );
  }
}

export async function v5F2(ctx: FlowCtx, check: CheckFn): Promise<void> {
  await check('F2: oracle match on purchase, upsell, revenue (both experiments)', async () => {
    const d = new Diff();
    const keys = ['purchase', 'upsell', 'revenue'];
    for (const exp of [EXP_A, EXP_B]) {
      compareRows(
        d,
        String(exp),
        dailySummary(model(ctx, exp), { keys }).rows,
        summary(ctx, exp).rows.filter((r) => keys.includes(r.metric_key)),
      );
    }
    return d.outcome('purchase / upsell / revenue rows equal');
  });
}

export async function v6(ctx: FlowCtx, check: CheckFn): Promise<void> {
  const keys = ['purchase', 'revenue', 'add_to_cart'];
  for (const dimension of ['device_type', 'channel', 'city', 'visitor_type']) {
    await check(
      `${dimension}: rows match the oracle; each value's rows sum to the core row`,
      async () => {
        const res = await ctx.api.query(EXP_A, body(EXP_A, { metrics: keys, dimension }));
        const rows = (res.rows as DailyRowLike[]) ?? [];
        const d = new Diff();
        compareRows(d, dimension, dailySummary(model(ctx, EXP_A), { keys, dimension }).rows, rows);
        if (dimension === 'city') {
          const values = [...new Set(rows.map((r) => String(r.dimension_value)))];
          d.eq('city values: 10 named + (other)', 11, values.length);
          d.truthy('(other) present', values.includes('(other)'));
        }
        const core = new Map(
          summary(ctx, EXP_A).rows.map((r) => [`${r.date}|${r.variation_id}|${r.metric_key}`, r]),
        );
        const sums = new Map<
          string,
          { visitors: number; converted: number; count: number; sum: number }
        >();
        for (const r of rows) {
          const k = `${r.date}|${r.variation_id}|${r.metric_key}`;
          const s = sums.get(k) ?? { visitors: 0, converted: 0, count: 0, sum: 0 };
          sums.set(k, {
            visitors: s.visitors + r.visitors,
            converted: s.converted + r.converted,
            count: s.count + r.count,
            sum: s.sum + r.sum,
          });
        }
        for (const [k, s] of sums) {
          const c = core.get(k);
          d.eq(`${k} visitors`, c?.visitors, s.visitors);
          d.eq(`${k} converted`, c?.converted, s.converted);
          d.eq(`${k} count`, c?.count, s.count);
          d.near(`${k} sum`, c?.sum ?? null, s.sum, 2 * MONEY_TOL);
        }
        return d.outcome(`${rows.length} rows, ${sums.size} core groups`);
      },
    );
  }
}

export async function v12F2(ctx: FlowCtx, check: CheckFn): Promise<void> {
  await check(
    'F2: RPV identity cr × orders_per_purchaser × aov + upsell_rpv = rpv per variation (±1e-6)',
    async () => {
      const d = new Diff();
      for (const exp of [EXP_A, EXP_B]) {
        for (const [v, s] of sumByVariation(summary(ctx, exp).rows)) {
          const m = deriveMetrics(s);
          const lhs =
            (m.cr ?? 0) * (m.orders_per_purchaser ?? 0) * (m.aov ?? 0) + (m.upsell_rpv ?? 0);
          d.near(`${exp}/${v} rpv`, m.rpv ?? null, lhs, 1e-6);
        }
      }
      return d.outcome('identity holds');
    },
  );

  await check('F2: cap_outliers query matches the oracle capped rows', async () => {
    const keys = ['purchase', 'revenue'];
    const res = await ctx.api.query(EXP_A, body(EXP_A, { metrics: keys, cap_outliers: true }));
    const d = new Diff();
    compareRows(
      d,
      'capped',
      dailySummary(model(ctx, EXP_A), { keys, capped: true }).rows,
      (res.rows as DailyRowLike[]) ?? [],
    );
    return d.outcome('capped rows equal');
  });
}

type Json = Record<string, unknown>;

/** Leaf-by-leaf comparison: money fields ±0.01, shares ±1e-6, everything else exact. */
export function deepCompare(d: Diff, path: string, expected: unknown, actual: unknown): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const money = /(revenue|from|to|bins\[\d+\])$/.test(path) && !/share/.test(path);
    d.near(path, expected, actual, money ? MONEY_TOL : 1e-6);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    d.eq(`${path}.length`, expected.length, actual.length);
    expected.forEach((e, i) => deepCompare(d, `${path}[${i}]`, e, actual[i]));
    return;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys)
      deepCompare(d, `${path}.${k}`, (expected as Json)[k], (actual as Json)[k]);
    return;
  }
  d.eq(path, expected, actual);
}

export async function v13F2(ctx: FlowCtx, check: CheckFn): Promise<void> {
  await check('F2: products view equals the oracle (top 8 + Other)', async () => {
    const res = await ctx.api.query(EXP_A, body(EXP_A, { view: 'products' }));
    const expected = products(model(ctx, EXP_A));
    const d = new Diff();
    deepCompare(d, 'products', expected, {
      ...(res.result as Json),
      experiment_id: expected.experiment_id,
    });
    return d.outcome('equal');
  });

  await check('F2: variant shares sum to 1 per variation (products with units)', async () => {
    const res = await ctx.api.query(EXP_A, body(EXP_A, { view: 'products' }));
    type Variant = { by_variation: Record<string, { share_of_product: number | null }> };
    type Product = {
      product_id: string;
      by_variation: Record<string, { units_purchased: number }>;
      variants: Variant[];
    };
    const d = new Diff();
    for (const p of ((res.result as { products: Product[] }).products ?? []).filter(
      (x) => x.variants.length > 0,
    )) {
      for (const [v, values] of Object.entries(p.by_variation)) {
        if (values.units_purchased === 0) continue;
        const total = p.variants.reduce(
          (s, x) => s + (x.by_variation[v]?.share_of_product ?? 0),
          0,
        );
        d.near(`${p.product_id} ${v}`, 1, total, 1e-5);
      }
    }
    return d.outcome('variant shares sum to 1');
  });

  await check('F2: distributions view equals the oracle', async () => {
    const res = await ctx.api.query(EXP_A, body(EXP_A, { view: 'distributions' }));
    const expected = distributions(model(ctx, EXP_A));
    const d = new Diff();
    deepCompare(d, 'distributions', expected, {
      ...(res.result as Json),
      experiment_id: expected.experiment_id,
    });
    return d.outcome('equal');
  });
}
