/**
 * Layer `sync`: crobot's real code (subscription service / jobs / webhook
 * receiver, running in the e2e container against MySQL crobot_e2e) talking to
 * the live platform. Nothing on either side is mocked.
 */

import { CROBOT_S9, F1_DASHBOARD, F1_PER_VARIATION } from '../expected/f1.ts';
import { type CheckDef, Diff, PendingError, fail, pass, pending } from '../lib/check.ts';
import { chQuery, chTableExists } from '../lib/clickhouse.ts';
import { deriveMetrics, sumByVariation } from '../lib/derive.ts';
import { signWebhook } from '../lib/hmac.ts';
import { http, waitFor } from '../lib/http.ts';
import { waitForReadySummary } from '../lib/platform-api.ts';
import { crobotApi, e2eArtisan } from '../stack/crobot.ts';
import { compareRows } from './contract-sync.ts';
import {
  CROBOT_CORE_METRICS,
  CROBOT_EXPERIMENT_PK,
  crobotAction,
  crobotState,
  crobotVariationPk,
  jsonCol,
} from './sync-support.ts';

const F1 = 1717;

async function sendWebhook(
  url: string,
  secret: string,
  body: object,
  tsSec: number,
): Promise<number> {
  const raw = JSON.stringify(body);
  const res = await http({
    method: 'POST',
    url,
    body: raw,
    headers: { ...signWebhook(raw, secret, tsSec) },
  });
  return res.status;
}

export const syncChecks: readonly CheckDef[] = [
  {
    id: 'sync.subscribe',
    layer: 'sync',
    title:
      "crobot subscribes 1717 → platform metric_subscriptions has crobot's core keys + goal:12, EUR, from 2026-10-01",
    owner: 'CB',
    dod: ['crobot §7a subscription', 'PRD-006 §3.1', 'X1'],
    needs: ['contract.f1-ingest', 'smoke.config-publish', 'infra.crobot-env'],
    async run(ctx) {
      const res = await crobotAction(ctx, 'subscribe', F1);
      if (!(await chTableExists(ctx.cfg.clickhouse, 'metric_subscriptions'))) {
        return pending('P0', 'ClickHouse metric_subscriptions table missing');
      }
      const rows = await chQuery<Record<string, unknown>>(
        ctx.cfg.clickhouse,
        `SELECT * FROM metric_subscriptions FINAL WHERE project_id = ${ctx.cfg.ids.projectId} AND experiment_id = ${F1} LIMIT 1`,
      );
      const sub = rows[0];
      if (sub === undefined)
        return fail(
          `crobot ran ${String(res.invoked)} but the platform stored no subscription for ${F1}`,
        );
      const metrics = (
        Array.isArray(sub.metrics) ? sub.metrics : jsonCol(sub.metrics)
      ) as readonly string[];
      const missing = [...CROBOT_CORE_METRICS, 'goal:12'].filter((k) => !metrics.includes(k));
      return new Diff()
        .eq('project_id', ctx.cfg.ids.projectId, Number(sub.project_id))
        .eq('report_currency', 'EUR', sub.report_currency)
        .eq('from', '2026-10-01', String(sub.from ?? sub.from_date ?? '').slice(0, 10))
        .eq('status', 'running', sub.status)
        .eq('missing core keys', [], missing)
        .outcome(`via ${String(res.invoked)}; ${metrics.length} keys`, { metrics });
    },
  },
  {
    id: 'sync.webhook-push',
    layer: 'sync',
    title:
      'platform run → signed summary-ready webhook → crobot worker syncs metric_summary (no manual trigger)',
    owner: 'P4+CB',
    dod: ['PRD-006 §3.2 webhook', 'crobot §7a webhook', 'V16 webhook'],
    needs: ['sync.subscribe'],
    async run(ctx) {
      const summary = await waitForReadySummary(ctx, F1, 180_000, (s) =>
        s.rows.some((r) => r.metric_key === 'goal:12'),
      );
      ctx.facts.set('sync.platformSummary', summary);
      const state = await waitFor(
        'crobot metric_summary rows for 1717 from the webhook-triggered job',
        async () => {
          const s = await crobotState(ctx, F1);
          return s.metricSummary.length > 0 ? s : undefined;
        },
        { timeoutMs: 90_000, intervalMs: 3_000, rethrow: (e) => e instanceof PendingError },
      ).catch((err: Error) => {
        throw new Error(
          `${err.message} — either the modeler sends no webhook (P4) or crobot's receiver/job didn't run (CB); see node_modules/.cache/e2e-cross/logs/modeler.log and crobot storage/logs/laravel.log`,
        );
      });
      return pass(
        `${state.metricSummary.length} rows synced by the worker for run ${summary.run_id}`,
      );
    },
  },
  {
    id: 'sync.pull-rows',
    layer: 'sync',
    title:
      'SyncMetricSummaryJob (dispatchSync) → crobot metric_summary == platform daily-summary rows; sync state ready + run_id',
    owner: 'CB',
    dod: ['crobot §7a ready row', 'crobot §9 live', 'X1'],
    needs: ['sync.subscribe'],
    async run(ctx) {
      const platform = await waitForReadySummary(ctx, F1, 180_000, (s) =>
        s.rows.some((r) => r.metric_key === 'goal:12'),
      );
      await crobotAction(ctx, 'sync', F1);
      const state = await crobotState(ctx, F1);
      ctx.facts.set('sync.crobotRows', state.metricSummary);
      const d = compareRows(platform.rows, state.metricSummary as never);
      d.eq('sync_state.status', 'ready', state.syncState?.status)
        .eq('sync_state.run_id', platform.run_id, state.syncState?.run_id)
        .truthy('sync_state.computed_at set', Boolean(state.syncState?.computed_at));
      const note = state.usedCrobotVariationIds
        ? ' (NOTE: crobot stores its own variations.id, mapped back)'
        : '';
      return d.outcome(
        `${state.metricSummary.length} rows identical to run ${platform.run_id}${note}`,
      );
    },
  },
  {
    id: 'sync.f1-values',
    layer: 'sync',
    title:
      'crobot metric_summary sums → F1 CR 33.33/66.67 %, AOV 100/62.50, RPV 33.33/48.33, upsell 0/50 %, cart abandonment 0/100 %, payment→purchase 100/200 %',
    owner: 'CB',
    dod: ['crobot §9 (data)', 'X1'],
    needs: ['sync.pull-rows'],
    async run(ctx) {
      const rows = ctx.facts.get('sync.crobotRows') as Parameters<typeof sumByVariation>[0];
      const sums = sumByVariation(rows);
      const d = new Diff();
      for (const variation of [100, 101] as const) {
        const v = sums.get(variation);
        if (v === undefined) {
          d.truthy(`variation ${variation} in crobot rows`, false);
          continue;
        }
        const got = deriveMetrics(v);
        const want = { ...F1_PER_VARIATION[variation], ...F1_DASHBOARD[variation] };
        for (const k of [
          'visitors',
          'purchasers',
          'cr',
          'aov',
          'rpv',
          'upsell_rate',
          'cart_abandonment',
          'step_payment_to_purchase',
        ] as const) {
          d.near(`${variation}.${k}`, want[k as keyof typeof want] as number, got[k], 1e-6);
        }
      }
      return d.outcome(`matches crobot §9: ${JSON.stringify(CROBOT_S9.purchase)}`);
    },
  },
  {
    id: 'sync.stats-row',
    layer: 'sync',
    title:
      'after a new run crobot stores full-range stats (POST /api/v1/stats) as an analytics_query_results `stats` row',
    owner: 'CB+P3',
    dod: ['crobot §7a ready row', 'PRD-006 §4.5'],
    needs: ['sync.pull-rows'],
    async run(ctx) {
      const state = await crobotState(ctx, F1);
      const stats = state.queryResults.find((r) => r.view === 'stats');
      if (stats === undefined)
        return fail('no analytics_query_results row with view=stats for 1717');
      const payload = jsonCol(stats.payload);
      return new Diff()
        .eq('status', 'ready', stats.status)
        .truthy(
          'payload.metrics present',
          typeof payload === 'object' && payload !== null && 'metrics' in payload,
        )
        .outcome('stats cached in MySQL');
    },
  },
  {
    id: 'sync.idempotent',
    layer: 'sync',
    title: 'second sync with no new run: rows unchanged, no duplicates (since_run_id path)',
    owner: 'CB',
    dod: ['crobot §7a unchanged', 'PRD-006 §3.4 since_run_id'],
    needs: ['sync.pull-rows'],
    async run(ctx) {
      const before = await crobotState(ctx, F1);
      await crobotAction(ctx, 'sync', F1);
      const after = await crobotState(ctx, F1);
      const keys = after.metricSummary.map((r) => `${r.date}|${r.variation_id}|${r.metric_key}`);
      return new Diff()
        .eq('row count', before.metricSummary.length, after.metricSummary.length)
        .eq('duplicate keys', 0, keys.length - new Set(keys).size)
        .eq('run_id', before.syncState?.run_id, after.syncState?.run_id)
        .outcome('replay is a no-op');
    },
  },
  {
    id: 'sync.webhook-auth',
    layer: 'sync',
    title:
      'crobot webhook: valid HMAC → 2xx; bad signature and stale (>5 min) timestamp → rejected',
    owner: 'CB',
    dod: ['crobot §4 VerifyAnalyticsWebhook', 'PRD-006 §3.2'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const url = `${ctx.cfg.crobot.url}/api/webhooks/analytics/summary-ready`;
      const body = {
        project_id: ctx.cfg.ids.projectId,
        experiment_id: F1,
        run_id: 'r_x0_probe',
        computed_at: new Date().toISOString(),
        data_through: new Date().toISOString(),
      };
      const now = Math.floor(Date.now() / 1000);
      // Before C9 the generic workflow route `/api/webhooks/{workflowType}/{event}`
      // swallows this URL (500 for the unknown type), so look at crobot's route table.
      const routes =
        (ctx.facts.get('crobot.info') as { routes?: readonly string[] } | undefined)?.routes ?? [];
      if (!routes.some((r) => r.includes('webhooks/analytics'))) {
        return pending('CB', 'no POST api/webhooks/analytics/{event} route in crobot yet (C9)');
      }
      const ok = await sendWebhook(url, ctx.cfg.secrets.webhook, body, now);
      const bad = await sendWebhook(url, 'wrong-secret-wrong-secret-0000', body, now);
      const stale = await sendWebhook(url, ctx.cfg.secrets.webhook, body, now - 600);
      return new Diff()
        .truthy(`valid signature → 2xx (got ${ok})`, ok >= 200 && ok < 300)
        .truthy(`bad signature → 401/403 (got ${bad})`, bad === 401 || bad === 403)
        .truthy(`stale timestamp → 401/403 (got ${stale})`, stale === 401 || stale === 403)
        .outcome('HMAC over timestamp.body enforced');
    },
  },
  {
    id: 'sync.extras',
    layer: 'sync',
    title:
      'crobot extras via its API (health, products, revenue, funnel) → FetchAnalyticsQueryJob → live queries → MySQL results',
    owner: 'CC+CB',
    dod: ['crobot §7a extras', 'crobot §6 screens', 'X1'],
    needs: ['sync.pull-rows'],
    async run(ctx) {
      const id = CROBOT_EXPERIMENT_PK[F1];
      for (const view of ['health', 'products', 'revenue', 'funnel']) {
        const res = await crobotApi(ctx.cfg, 'GET', `/api/experiments/${id}/analytics/${view}`);
        if (res.status === 404 && !res.text.includes('{'))
          return pending('CC', `GET /api/experiments/{id}/analytics/${view} not routed (C3)`);
        if (res.status === 501)
          return pending(
            view === 'health' || view === 'products' ? 'CD' : 'CD',
            `analytics view ${view} returns 501 (C5–C7)`,
          );
        if (res.status >= 400)
          return fail(`GET analytics/${view} → ${res.status}: ${res.text.slice(0, 200)}`);
      }
      const state = await waitFor(
        'crobot analytics_query_results ready for health + products + distributions + summary',
        async () => {
          const s = await crobotState(ctx, F1);
          const ready = new Set(
            s.queryResults.filter((r) => r.status === 'ready').map((r) => String(r.view)),
          );
          return ['health', 'products', 'distributions', 'summary'].every((v) => ready.has(v))
            ? s
            : undefined;
        },
        { timeoutMs: 180_000, intervalMs: 3_000, rethrow: (e) => e instanceof PendingError },
      );
      const payload = (view: string): unknown =>
        jsonCol(state.queryResults.find((r) => r.view === view && r.status === 'ready')?.payload);
      const healthText = JSON.stringify(payload('health'));
      const productsText = JSON.stringify(payload('products'));
      return new Diff()
        .truthy(
          'health payload has add_to_cart warning',
          /"event_name":"add_to_cart"[^}]*"status":"warning"/.test(healthText) ||
            /add_to_cart.{0,200}warning/.test(healthText),
        )
        .truthy('products payload has SKU-A', productsText.includes('SKU-A'))
        .outcome('extras fetched live and cached');
    },
  },
  {
    id: 'sync.f3-label',
    layer: 'sync',
    title:
      'F3 experiment 1903: crobot subscribe + sync + stats → purchase goal Inconclusive at 95 % (91 %)',
    owner: 'CB+CC+P3',
    dod: ['crobot §9 F3 label', 'V7', 'X1'],
    needs: ['contract.f3-ingest', 'infra.crobot-env'],
    async run(ctx) {
      const f3 = ctx.cfg.ids.f3;
      await crobotAction(ctx, 'subscribe', f3);
      await waitForReadySummary(ctx, f3, 240_000);
      await crobotAction(ctx, 'sync', f3);
      const state = await crobotState(ctx, f3);
      const stats = JSON.stringify(
        jsonCol(state.queryResults.find((r) => r.view === 'stats')?.payload) ?? null,
      );
      // crobot keys stats by its own variations.id (seed: 1903 / identifier 101 → 6006).
      const pk = crobotVariationPk(f3, 101);
      const beat = Number(
        new RegExp(`"${pk}":\\{[^}]*"chance_to_beat_control":([0-9.]+)`).exec(stats)?.[1] ??
          Number.NaN,
      );
      const res = await crobotApi(
        ctx.cfg,
        'GET',
        `/api/experiments/${CROBOT_EXPERIMENT_PK[f3]}/analytics/goal-table`,
      );
      if (res.status === 404 && !res.text.includes('{'))
        return pending('CC', 'goal-table view not routed (C3)');
      return new Diff()
        .truthy(
          `stats 101 (crobot variation ${pk}) chance_to_beat_control ${beat} in [0.902, 0.912]`,
          beat >= 0.902 && beat <= 0.912,
        )
        .truthy('goal-table labels the purchase goal Inconclusive', /inconclusive/i.test(res.text))
        .truthy('no Better / Worse verdict', !/"(better|worse)"/i.test(res.text))
        .outcome(`F3: beat=${beat}, label Inconclusive`);
    },
  },
  {
    id: 'sync.v1-guard',
    layer: 'sync',
    title: 'crobot refuses to subscribe the v1 experiment 1900 (client refuses v1 ids)',
    owner: 'CA+CB',
    dod: ['crobot §3a guards'],
    needs: ['infra.crobot-db'],
    async run(ctx) {
      const res = await e2eArtisan(ctx.cfg, 'subscribe', ctx.cfg.ids.v1Experiment);
      if (res.pending) return pending('CB', String(res.error));
      // The invoker's ok flag alone is not proof: a silent no-op also returns ok.
      // The platform must hold no subscription for the v1 experiment either way.
      const leaked = await chQuery<{ n: string }>(
        ctx.cfg.clickhouse,
        `SELECT count() AS n FROM metric_subscriptions FINAL WHERE project_id = ${ctx.cfg.ids.projectId} AND experiment_id = ${ctx.cfg.ids.v1Experiment}`,
      );
      if (Number(leaked[0]?.n ?? 0) > 0)
        return fail('platform holds a subscription for the v1 experiment');
      if (res.ok) return fail('crobot reported success subscribing a v1 experiment');
      return /version|v1|v2/i.test(String(res.error))
        ? pass(String(res.error))
        : fail(`refused, but not for the version: ${res.error}`);
    },
  },
];
