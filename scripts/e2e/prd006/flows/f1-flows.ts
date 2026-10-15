/**
 * F1 flows (006-validation.md V1, V2, V3, V14 and the F1 halves of V5, V12,
 * V13): every expected value is a literal from `fixtures/f1.ts` or the
 * committed golden `docs/reference/samples/f1/modeled/daily_summary.json`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chQuery } from '../../cross/lib/clickhouse.ts';
import { deriveMetrics, sumByVariation } from '../../cross/lib/derive.ts';
import type { WireEvent } from '../../cross/shared/f1-wire.ts';
import { SAMPLES_DIR } from '../config.ts';
import {
  F1,
  F1_BUY_TO_CART,
  F1_D2,
  F1_DAILY_PURCHASE,
  F1_DASHBOARD,
  F1_DISTRIBUTIONS,
  F1_EXP_1802,
  F1_FROM,
  F1_HEALTH,
  F1_PAYMENT_TYPE,
  F1_PRODUCTS,
  F1_QUALITY,
  F1_STOPPED_D2,
  F1_SUMMED,
  F1_TO,
  F1_UNITS_SHARE,
} from '../fixtures/f1.ts';
import type { DailyRowLike, SummaryBody } from './api.ts';
import { Diff, F1_KEYS, type FlowCtx, fact, fail, pass } from './types.ts';

const EXP = 1717;
const num = (v: unknown): number => Number(v);
const money = (x: number) => Math.round(x * 100) / 100;

const f1Summary = (ctx: FlowCtx) => fact<SummaryBody>(ctx, 'f1.summary.1717');

/** Σ rows → derived metrics per variation (crobot's arithmetic, X0 `derive.ts`). */
function derived(rows: readonly DailyRowLike[]) {
  const sums = sumByVariation(rows);
  const out = new Map<number, Record<string, number | null>>();
  for (const [v, s] of sums) {
    const m = deriveMetrics(s);
    const units = s.keys.get('units')?.count ?? 0;
    const upsellUnits = s.keys.get('units_upsell')?.count ?? 0;
    out.set(v, { ...m, units_sold: units + upsellUnits });
  }
  return out;
}

// ─── V1 ─────────────────────────────────────────────────────────────────────

export async function v1(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check(
    'events rows carry exp arrays, purchase/entry/channel/os/browser fields as sent',
    async () => {
      const wire = fact<WireEvent[]>(ctx, 'f1.wire');
      const rows = await chQuery<Record<string, unknown>>(
        ctx.cfg.ch,
        `SELECT toString(event_id) AS event_id, exp_ids, exp_var_ids, exp_session_starts, exp_session_idx,
         purchase_type, parent_order_id, entry_referrer, entry_url, entry_utm_source, entry_utm_medium,
         entry_utm_campaign, entry_utm_term, entry_utm_content, channel, os_name, browser_name
       FROM events WHERE project_id = ${F1.projectId}`,
      );
      const byId = new Map(rows.map((r) => [String(r.event_id), r]));
      const d = new Diff();
      d.eq('row count', wire.length, rows.length);
      for (const e of wire) {
        const r = byId.get(e.event_id);
        if (!r) {
          d.truthy(`${e.event_id} (${e.event_name}) stored`, false);
          continue;
        }
        const exp = (e.exp as readonly (readonly number[])[]) ?? [];
        const label = `${String(e.visitor_id)} ${e.event_name}`;
        d.eq(
          `${label} exp_ids`,
          exp.map((t) => t[0]),
          (r.exp_ids as unknown[]).map(num),
        );
        d.eq(
          `${label} exp_var_ids`,
          exp.map((t) => t[1]),
          (r.exp_var_ids as unknown[]).map(num),
        );
        d.eq(
          `${label} exp_session_starts`,
          exp.map((t) => t[2]),
          (r.exp_session_starts as unknown[]).map(num),
        );
        d.eq(
          `${label} exp_session_idx`,
          exp.map((t) => t[3]),
          (r.exp_session_idx as unknown[]).map(num),
        );
        for (const f of [
          'purchase_type',
          'parent_order_id',
          'entry_referrer',
          'entry_url',
          'entry_utm_source',
          'entry_utm_medium',
          'entry_utm_campaign',
          'entry_utm_term',
          'entry_utm_content',
          'channel',
          'os_name',
          'browser_name',
        ]) {
          d.eq(`${label} ${f}`, String(e[f] ?? ''), String(r[f] ?? ''));
        }
      }
      return d.outcome(`${wire.length} events match`);
    },
  );

  await check("v1's purchase wrote 1 event_items row per item", async () => {
    const wire = fact<WireEvent[]>(ctx, 'f1.wire');
    const v1Purchase = wire.find((e) => e.visitor_id === 'v1' && e.event_name === 'purchase');
    if (!v1Purchase) return fail('v1 purchase not in F1 wire events');
    const items = (v1Purchase.items as unknown[] | undefined) ?? [];
    const [row] = await chQuery<{ n: string }>(
      ctx.cfg.ch,
      `SELECT count() AS n FROM event_items WHERE project_id = ${F1.projectId} AND event_id = toUUID('${v1Purchase.event_id}')`,
    );
    return num(row?.n) === items.length
      ? pass(`${items.length} item row(s)`)
      : fail('event_items rows', items.length, num(row?.n));
  });
}

// ─── V2 ─────────────────────────────────────────────────────────────────────

interface GoldenSummary {
  readonly rows: readonly DailyRowLike[];
}

const rowKey = (r: DailyRowLike) => `${r.date}|${r.variation_id}|${r.metric_key}`;

export async function v2(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check('raw daily rows equal f1/modeled/daily_summary.json', async () => {
    const golden = JSON.parse(
      readFileSync(join(SAMPLES_DIR, 'f1', 'modeled', 'daily_summary.json'), 'utf8'),
    ) as GoldenSummary;
    const keys = new Set(golden.rows.map((r) => r.metric_key));
    const got = new Map(
      f1Summary(ctx)
        .rows.filter((r) => keys.has(r.metric_key))
        .map((r) => [rowKey(r), r]),
    );
    const d = new Diff();
    d.eq('row count (golden keys)', golden.rows.length, got.size);
    for (const g of golden.rows) {
      const r = got.get(rowKey(g));
      if (!r) {
        d.truthy(`row ${rowKey(g)} present`, false);
        continue;
      }
      for (const f of ['visitors', 'converted', 'count'] as const)
        d.eq(`${rowKey(g)} ${f}`, g[f], r[f]);
      for (const f of ['sum', 'sum_sq', 'sum_sq_visitor'] as const)
        d.near(`${rowKey(g)} ${f}`, g[f], r[f], 0.01);
    }
    return d.outcome(`${golden.rows.length} rows equal`);
  });

  await check(
    'summed values equal the per-variation table (counts exact, ratios ±1e-6)',
    async () => {
      const m = derived(f1Summary(ctx).rows);
      const d = new Diff();
      const map: Record<string, string> = {
        visitors: 'visitors',
        purchasers: 'purchasers',
        orders: 'orders',
        revenue: 'revenue',
        cr: 'cr',
        aov: 'aov',
        rpv: 'rpv',
        add_to_cart_rate: 'add_to_cart_rate',
        begin_checkout_rate: 'begin_checkout_rate',
        lead_rate: 'lead_rate',
        upsell_rate: 'upsell_rate',
        'event:size_guide_opened': 'event_size_guide_opened',
        'goal:12': 'goal_12',
      };
      for (const [label, expected] of Object.entries(F1_SUMMED)) {
        for (const v of [100, 101] as const) {
          d.near(`${label} ${v}`, expected[v], m.get(v)?.[map[label] ?? label] ?? null, 1e-6);
        }
      }
      return d.outcome('13 values × 2 variations');
    },
  );

  await check('quality exact', async () => {
    const q = f1Summary(ctx).quality ?? {};
    const d = new Diff()
      .eq(
        'multi_variation_visitors',
        F1_QUALITY.multi_variation_visitors,
        q.multi_variation_visitors,
      )
      .eq(
        'variation_mismatch_events',
        F1_QUALITY.variation_mismatch_events,
        q.variation_mismatch_events,
      );
    return d.outcome(JSON.stringify(q));
  });

  await check(
    'experiment 1802: variation 200 visitors 1, purchasers 1, revenue 60.00; 201 no rows',
    async () => {
      const s = fact<SummaryBody>(ctx, 'f1.summary.1802');
      const m = derived(s.rows);
      const v = m.get(F1_EXP_1802.variation);
      return new Diff()
        .eq('visitors', F1_EXP_1802.visitors, v?.visitors)
        .eq('purchasers', F1_EXP_1802.purchasers, v?.purchasers)
        .near('revenue', F1_EXP_1802.revenue, v?.revenue ?? null, 0.01)
        .eq('variation 201 rows', 0, s.rows.filter((r) => r.variation_id === 201).length)
        .outcome('1802 rows as expected');
    },
  );
}

// ─── V3 ─────────────────────────────────────────────────────────────────────

export async function v3(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check('daily purchase rows D1–D3 exact', async () => {
    const rows = f1Summary(ctx).rows.filter((r) => r.metric_key === 'purchase');
    const d = new Diff();
    d.eq('purchase rows', F1_DAILY_PURCHASE.length, rows.length);
    for (const e of F1_DAILY_PURCHASE) {
      const r = rows.find((x) => x.date === e.date && x.variation_id === e.variation_id);
      d.eq(`${e.date} ${e.variation_id} visitors`, e.visitors, r?.visitors);
      d.eq(`${e.date} ${e.variation_id} purchasers`, e.converted, r?.converted);
    }
    return d.outcome('4 rows');
  });

  await check('v3 is once in exposures with max_session_idx = 2', async () => {
    const rows = await chQuery<{ n: string; idx: string }>(
      ctx.cfg.ch,
      `SELECT count() AS n, max(m) AS idx FROM (
         SELECT visitor_id, max(max_session_idx) AS m FROM exposures
         WHERE project_id = ${F1.projectId} AND experiment_id = ${EXP} AND visitor_id = 'v3'
         GROUP BY visitor_id)`,
    );
    return new Diff()
      .eq('visitors', 1, num(rows[0]?.n))
      .eq('max_session_idx', 2, num(rows[0]?.idx))
      .outcome('v3 once, idx 2');
  });

  await check('v3 is `returning` in a visitor_type query', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'summary',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
      metrics: ['purchase'],
      dimension: 'visitor_type',
    });
    const rows = (res.rows as DailyRowLike[]) ?? [];
    const ret = rows.filter((r) => r.dimension_value === 'returning');
    return new Diff()
      .eq(
        'returning rows (date, variation, visitors)',
        [['2026-10-01', 101, 1]],
        ret.map((r) => [r.date, r.variation_id, r.visitors]),
      )
      .outcome('v3 returning on D1 in 101');
  });

  await check(
    'stopped subscription to = D2: variant purchasers 1, revenue 65.00, visitors 3 / 3',
    async () => {
      const before = f1Summary(ctx).run_id;
      const put = await ctx.api.subscribe(EXP, {
        projectId: F1.projectId,
        from: F1_FROM,
        to: F1_D2,
        status: 'stopped',
        metrics: F1_KEYS,
      });
      if (put.status !== 200) return fail(`PUT stopped → ${put.status}: ${put.text.slice(0, 200)}`);
      try {
        const s = await ctx.api.waitReady(EXP, { notRunId: before });
        const m = derived(s.rows);
        return new Diff()
          .eq('purchasers 100', F1_STOPPED_D2.purchasers[100], m.get(100)?.purchasers)
          .eq('purchasers 101', F1_STOPPED_D2.purchasers[101], m.get(101)?.purchasers)
          .near('revenue 101', F1_STOPPED_D2.revenue101, m.get(101)?.revenue ?? null, 0.01)
          .eq('visitors 100', F1_STOPPED_D2.visitors[100], m.get(100)?.visitors)
          .eq('visitors 101', F1_STOPPED_D2.visitors[101], m.get(101)?.visitors)
          .outcome('stopped run exact');
      } finally {
        // Back to the running subscription for the flows after this one.
        await ctx.api.subscribe(EXP, {
          projectId: F1.projectId,
          from: F1_FROM,
          to: null,
          metrics: F1_KEYS,
        });
        ctx.facts.set('f1.summary.1717', await ctx.api.waitReady(EXP));
      }
    },
  );
}

// ─── V5 / V12 / V13 F1 halves ───────────────────────────────────────────────

export async function v5F1(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check(
    'F1: v1 reload duplicate counted once (control orders 1, revenue 100.00)',
    async () => {
      const m = derived(f1Summary(ctx).rows).get(100);
      return new Diff()
        .eq('orders', 1, m?.orders)
        .near('revenue', 100, m?.revenue ?? null, 0.01)
        .outcome('deduped');
    },
  );
}

export async function v12F1(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check('F1 "V2 dashboard metrics" table exact from summed rows', async () => {
    const m = derived(f1Summary(ctx).rows);
    const d = new Diff();
    for (const [label, expected] of Object.entries(F1_DASHBOARD)) {
      const key = label.replace(':', '_').replace('reached_', 'reached_');
      const field =
        label === 'cart_purchase'
          ? 'cart_purchase_converted'
          : label === 'checkout_purchase'
            ? 'checkout_purchase_converted'
            : key;
      for (const v of [100, 101] as const)
        d.near(`${label} ${v}`, expected[v], m.get(v)?.[field] ?? null, 1e-6);
    }
    return d.outcome(`${Object.keys(F1_DASHBOARD).length} values × 2 variations`);
  });

  await check('payment_type split: card / paypal 1 / 1, rows post_exposure', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'summary',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
      metrics: ['add_payment_info', 'purchase'],
      dimension: 'payment_type',
    });
    const rows = (res.rows as DailyRowLike[]) ?? [];
    const d = new Diff();
    d.truthy(
      'every row post_exposure',
      rows.length > 0 && rows.every((r) => r.post_exposure === true),
    );
    for (const v of [100, 101] as const) {
      const e = F1_PAYMENT_TYPE[v];
      const of = (k: string) =>
        rows
          .filter(
            (r) => r.variation_id === v && r.dimension_value === e.value && r.metric_key === k,
          )
          .reduce((s, r) => s + r.converted, 0);
      d.eq(`${v} ${e.value} add_payment_info`, e.add_payment_info, of('add_payment_info'));
      d.eq(`${v} ${e.value} purchase`, e.purchase, of('purchase'));
    }
    return d.outcome('payment_type rows');
  });
}

type ProductRow = {
  product_id: string;
  by_variation: Record<string, Record<string, number | null>>;
};
type Bucket = { value: string; count: number; share: number };

export async function v13F1(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check('F1 products table exact', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'products',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
    });
    const products = (res.result as { products?: ProductRow[] })?.products ?? [];
    const d = new Diff();
    for (const [pid, perVar] of Object.entries(F1_PRODUCTS)) {
      const p = products.find((x) => x.product_id === pid);
      for (const [v, [added, bought, revenue, share]] of Object.entries(perVar)) {
        const b = p?.by_variation[v];
        d.eq(`${pid} ${v} added`, added, b?.units_added);
        d.eq(`${pid} ${v} purchased`, bought, b?.units_purchased);
        d.near(`${pid} ${v} revenue`, revenue, (b?.revenue as number) ?? null, 0.01);
        d.near(`${pid} ${v} revenue_share`, share, (b?.revenue_share as number) ?? null, 1e-6);
      }
    }
    for (const [pid, perVar] of Object.entries(F1_BUY_TO_CART)) {
      for (const [v, expected] of Object.entries(perVar)) {
        d.near(
          `${pid} ${v} buy_to_cart`,
          expected,
          products.find((x) => x.product_id === pid)?.by_variation[v]?.buy_to_cart ?? null,
          1e-6,
        );
      }
    }
    for (const [v, shares] of Object.entries(F1_UNITS_SHARE)) {
      for (const [pid, expected] of Object.entries(shares)) {
        d.near(
          `${pid} ${v} units_share`,
          expected,
          products.find((x) => x.product_id === pid)?.by_variation[v]?.units_share ?? null,
          1e-6,
        );
      }
    }
    return d.outcome(`${products.length} products`);
  });

  await check('F1 distributions table exact', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'distributions',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
    });
    const dists =
      (res.result as { distributions?: Record<string, { by_variation: Record<string, Bucket[]> }> })
        ?.distributions ?? {};
    const d = new Diff();
    for (const [key, perVar] of Object.entries(F1_DISTRIBUTIONS)) {
      for (const [v, buckets] of Object.entries(perVar)) {
        const got = (dists[key]?.by_variation[v] ?? []).map((b) => [b.value, b.count, b.share]);
        d.eq(`${key} ${v}`, buckets, got);
      }
    }
    return d.outcome('payment_type, coupon, currency');
  });
}

// ─── V14 ────────────────────────────────────────────────────────────────────

interface HealthEvent {
  event_name: string;
  status: string;
  events: Record<string, number>;
  params: { param: string; present_pct: number | null }[];
}
interface Health {
  events: HealthEvent[];
  metrics: { key: string; availability: string }[];
  summary: { param_warnings: number };
}

export async function v14(ctx: FlowCtx, check: import('./types.ts').CheckFn): Promise<void> {
  await check('F1 health expectations', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'health',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
    });
    const h = res.result as Health;
    const ev = (n: string) => h.events.find((e) => e.event_name === n);
    const param = (n: string, p: string) => ev(n)?.params.find((x) => x.param === p)?.present_pct;
    return new Diff()
      .eq('purchase events', F1_HEALTH.purchase_events, {
        100: ev('purchase')?.events['100'],
        101: ev('purchase')?.events['101'],
      })
      .eq('purchase status', F1_HEALTH.purchase_status, ev('purchase')?.status)
      .near(
        'add_to_cart items[].price present',
        F1_HEALTH.add_to_cart_price_present,
        param('add_to_cart', 'items[].price') ?? null,
      )
      .eq('add_to_cart status', F1_HEALTH.add_to_cart_status, ev('add_to_cart')?.status)
      .near(
        'add_payment_info payment_type present',
        F1_HEALTH.payment_type_present,
        param('add_payment_info', 'payment_type') ?? null,
      )
      .truthy(
        'summary.param_warnings ≥ 1',
        h.summary.param_warnings >= F1_HEALTH.min_param_warnings,
      )
      .outcome('health as expected');
  });

  await check('metrics depending on a param below 95% are `limited`', async () => {
    const res = await ctx.api.query(EXP, {
      view: 'health',
      project_id: F1.projectId,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
    });
    const h = res.result as Health;
    const limited = h.metrics
      .filter((m) => m.availability === 'limited')
      .map((m) => m.key)
      .sort();
    return new Diff()
      .eq('limited metrics', ['add_to_cart_rate', 'buy_to_cart'], limited)
      .outcome('add_to_cart metrics limited');
  });
}

export const f1Money = money;
