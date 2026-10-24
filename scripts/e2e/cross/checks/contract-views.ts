/**
 * Layer `contract`, part 3: on-demand queries (summary + dimension, products,
 * distributions, health — PRD-006 §3.5 / §6.5) and the stateless stats
 * endpoint (§4.5) with the F3 golden.
 */

import {
  F1_DISTRIBUTIONS,
  F1_FROM,
  F1_HEALTH,
  F1_PAYMENT_TYPE,
  F1_PRODUCTS,
  F1_TO,
} from '../expected/f1.ts';
import { F3_EXPECTED, F3_STATS_REQUEST } from '../expected/f3.ts';
import { type CheckDef, type Ctx, Diff, PendingError, fail } from '../lib/check.ts';
import { field, waitFor } from '../lib/http.ts';
import { assertBuilt, expPath, platformApi, queryBody, scopedPath } from '../lib/platform-api.ts';
import { queryAccepted, queryResult, schemaIssues, statsResponse } from '../lib/schemas.ts';

type QueryBody = Readonly<Record<string, unknown>>;

/** POST a query and poll it to `ready`; pending when the view isn't built. */
async function runQuery(
  ctx: Ctx,
  body: QueryBody,
  owner: string,
): Promise<Record<string, unknown>> {
  const id = ctx.cfg.ids.f1;
  const post = await platformApi(ctx, {
    method: 'POST',
    path: expPath(id, 'queries'),
    body: queryBody(ctx, body),
  });
  assertBuilt(post, owner, `POST queries view=${String(body.view)}`);
  if (post.status !== 202 && post.status !== 200)
    throw new Error(`POST queries → ${post.status}: ${post.text.slice(0, 200)}`);
  const accepted = queryAccepted.safeParse(post.json);
  if (!accepted.success) throw new Error(`POST queries schema: ${schemaIssues(accepted.error)}`);
  const queryId = accepted.data.query_id;
  return waitFor(
    `query ${queryId} ready`,
    async () => {
      const res = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, id, `queries/${queryId}`),
      });
      assertBuilt(res, owner, 'GET queries/{id}');
      const parsed = queryResult.safeParse(res.json);
      if (!parsed.success) throw new Error(`GET query schema: ${schemaIssues(parsed.error)}`);
      if (parsed.data.status === 'failed') {
        const err = JSON.stringify(field(res.json, 'error') ?? res.json);
        if (/not_implemented/.test(err))
          throw new PendingError(owner, `view ${String(body.view)} not implemented`);
        throw new Error(`query failed: ${err.slice(0, 300)}`);
      }
      return parsed.data.status === 'ready' ? (res.json as Record<string, unknown>) : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 2_000, rethrow: (e) => e instanceof PendingError },
  );
}

const range = { from: F1_FROM, to: F1_TO } as const;

function byVariation(node: unknown): Record<string, unknown> {
  const inner = field(node, 'by_variation');
  return (inner ?? node ?? {}) as Record<string, unknown>;
}

export const contractViewChecks: readonly CheckDef[] = [
  {
    id: 'contract.query-payment-type',
    layer: 'contract',
    title:
      'V12: summary query dimension=payment_type (add_payment_info + purchase): card 1/1 vs paypal 1/1, post_exposure',
    owner: 'P4',
    dod: ['V12', 'PRD-006 §6.3', 'crobot §6 Funnel'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const result = await runQuery(
        ctx,
        {
          view: 'summary',
          ...range,
          metrics: ['add_payment_info', 'purchase'],
          dimension: 'payment_type',
          refresh: false,
        },
        'P4',
      );
      const rows = (result.rows ?? []) as readonly Record<string, unknown>[];
      const d = new Diff();
      for (const variation of [100, 101] as const) {
        const want = F1_PAYMENT_TYPE[variation];
        const mine = rows.filter(
          (r) => r.variation_id === variation && r.dimension_value === want.value,
        );
        const conv = (key: string): number =>
          mine
            .filter((r) => r.metric_key === key)
            .reduce((s, r) => s + Number(r.converted ?? 0), 0);
        d.eq(
          `${variation} ${want.value} add_payment_info`,
          want.add_payment_info,
          conv('add_payment_info'),
        );
        d.eq(`${variation} ${want.value} purchase`, want.purchase, conv('purchase'));
      }
      d.truthy(
        'rows carry post_exposure: true',
        rows.length > 0 && rows.every((r) => r.post_exposure === true),
      );
      return d.outcome('payment_type split exact', { rows: rows.length });
    },
  },
  {
    id: 'contract.query-dedup',
    layer: 'contract',
    title: 'V16: same query body → same query_id; cached result returns 200 ready',
    owner: 'P4',
    dod: ['V16', 'PRD-006 §3.5'],
    needs: ['contract.query-payment-type'],
    async run(ctx) {
      const body = queryBody(ctx, {
        view: 'summary',
        ...range,
        metrics: ['add_payment_info', 'purchase'],
        dimension: 'payment_type',
        refresh: false,
      });
      const path = expPath(ctx.cfg.ids.f1, 'queries');
      const a = await platformApi(ctx, { method: 'POST', path, body });
      const b = await platformApi(ctx, { method: 'POST', path, body: { ...body, refresh: false } });
      return new Diff()
        .eq('same query_id', field(a.json, 'query_id'), field(b.json, 'query_id'))
        .eq('cached POST', [200, 'ready'], [b.status, field(b.json, 'status')])
        .outcome('dedup + 1 h cache');
    },
  },
  {
    id: 'contract.query-products',
    layer: 'contract',
    title: 'V13: products view = F1 products table (SKU-A units share 1.0 vs 0.5)',
    owner: 'P7',
    dod: ['V13', 'crobot §9 SKU-A units share'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const out = await runQuery(
        ctx,
        { view: 'products', ...range, purchase_type: 'all', limit: 50 },
        'P7',
      );
      const products = (field(out.result, 'products') ?? []) as readonly Record<string, unknown>[];
      const d = new Diff();
      for (const [sku, perVar] of Object.entries(F1_PRODUCTS)) {
        const row = products.find((p) => p.product_id === sku);
        if (row === undefined) {
          d.truthy(`${sku} listed`, false);
          continue;
        }
        const got = byVariation(row);
        for (const [variation, metrics] of Object.entries(perVar)) {
          for (const [k, want] of Object.entries(metrics as Record<string, number | null>)) {
            d.near(
              `${sku} ${variation} ${k}`,
              want,
              field(got[variation], k) as number | null,
              1e-6,
            );
          }
        }
      }
      return d.outcome('F1 products exact', { products: products.length });
    },
  },
  {
    id: 'contract.query-distributions',
    layer: 'contract',
    title: 'V13: distributions view = F1 (payment_type, coupon, currency)',
    owner: 'P7',
    dod: ['V13', 'crobot §6 Revenue'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const out = await runQuery(
        ctx,
        { view: 'distributions', ...range, distributions: ['payment_type', 'coupon', 'currency'] },
        'P7',
      );
      const dists = (field(out.result, 'distributions') ?? out.result) as Record<string, unknown>;
      const d = new Diff();
      for (const [name, perVar] of Object.entries(F1_DISTRIBUTIONS)) {
        const got = byVariation(dists?.[name]);
        for (const [variation, entries] of Object.entries(perVar)) {
          const list = (got[variation] ?? []) as readonly {
            value: string;
            count: number;
            share: number;
          }[];
          for (const [value, count, share] of entries as readonly (readonly [
            string,
            number,
            number,
          ])[]) {
            const e = list.find((x) => x.value === value);
            d.eq(`${name} ${variation} ${value} count`, count, e?.count);
            d.near(`${name} ${variation} ${value} share`, share, e?.share, 1e-6);
          }
        }
      }
      return d.outcome('F1 distributions exact');
    },
  },
  {
    id: 'contract.query-health',
    layer: 'contract',
    title:
      'V14: health view — purchase ok (variant 3 events), add_to_cart warning (price 0.5), payment_type 1.0',
    owner: 'P8',
    dod: ['V14', 'crobot §9 health warning'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const out = await runQuery(ctx, { view: 'health', ...range }, 'P8');
      const events = (field(out.result, 'events') ?? []) as readonly Record<string, unknown>[];
      const ev = (name: string): Record<string, unknown> | undefined =>
        events.find((e) => e.event_name === name);
      const param = (name: string, p: string): number | undefined =>
        ((ev(name)?.params ?? []) as readonly { param: string; present_pct: number }[]).find(
          (x) => x.param === p,
        )?.present_pct;
      const summary = field(out.result, 'summary');
      return new Diff()
        .eq('purchase status', F1_HEALTH.purchaseStatus, ev('purchase')?.status)
        .eq(
          'purchase events variant',
          F1_HEALTH.purchaseEventsVariant,
          field(ev('purchase')?.events, '101'),
        )
        .eq('add_to_cart status', F1_HEALTH.addToCartStatus, ev('add_to_cart')?.status)
        .near(
          'add_to_cart items[].price present',
          F1_HEALTH.addToCartPricePresent,
          param('add_to_cart', 'items[].price'),
        )
        .near(
          'add_payment_info payment_type present',
          F1_HEALTH.paymentTypePresent,
          param('add_payment_info', 'payment_type'),
        )
        .truthy(
          'summary.param_warnings ≥ 1',
          Number(field(summary, 'param_warnings') ?? 0) >= F1_HEALTH.minParamWarnings,
        )
        .outcome('F1 health expectations');
    },
  },
  {
    id: 'contract.stats-f3',
    layer: 'contract',
    title:
      'V7: POST /api/v1/stats with F3 sums — 101 beat ∈ [0.902, 0.912], best ∈ [0.871, 0.881]; deterministic; insufficient_data; control flip',
    owner: 'P3',
    dod: ['V7', 'PRD-006 §4.4 golden', 'crobot §9 F3 (platform side)'],
    needs: ['infra.collector'],
    async run(ctx) {
      const call = (body: unknown) =>
        platformApi(ctx, { method: 'POST', path: '/api/v1/stats', body });
      const a = await call(F3_STATS_REQUEST);
      assertBuilt(a, 'P3', 'POST /api/v1/stats');
      const parsed = statsResponse.safeParse(a.json);
      if (a.status !== 200 || !parsed.success) {
        return fail(
          `stats ${a.status}: ${parsed.success ? a.text.slice(0, 200) : schemaIssues(parsed.error)}`,
        );
      }
      const cr = parsed.data.metrics.cr ?? {};
      const v101 = cr['101'] ?? {};
      const b = await call(F3_STATS_REQUEST);
      const small = await call(F3_EXPECTED.insufficientRequest);
      const flipped = await call({ ...F3_STATS_REQUEST, control: 101 });
      const [lo, hi] = F3_EXPECTED.chanceToBeatControl101;
      const [blo, bhi] = F3_EXPECTED.chanceToBeBest101;
      const beat = v101.chance_to_beat_control ?? -1;
      const best = v101.chance_to_be_best ?? -1;
      const flippedCr = field(field(flipped.json, 'metrics'), 'cr');
      return new Diff()
        .truthy(`101 chance_to_beat_control ${beat} in [${lo}, ${hi}]`, beat >= lo && beat <= hi)
        .truthy(`101 chance_to_be_best ${best} in [${blo}, ${bhi}]`, best >= blo && best <= bhi)
        .eq('control keys', ['chance_to_be_best'], Object.keys(cr['100'] ?? {}).sort())
        .truthy('identical input → byte-identical output', a.text === b.text)
        .eq(
          '< 100 visitors → insufficient_data',
          true,
          field(field(field(field(small.json, 'metrics'), 'cr'), '101'), 'insufficient_data'),
        )
        .truthy(
          'control: 101 flips the reference',
          field(field(flippedCr, '100'), 'chance_to_beat_control') !== undefined &&
            field(field(flippedCr, '101'), 'chance_to_beat_control') === undefined,
        )
        .outcome(`101 beat=${beat} best=${best}`);
    },
  },
];
