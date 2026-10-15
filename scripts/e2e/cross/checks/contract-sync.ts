/**
 * Layer `contract`, part 2: the live sync API (PRD-006 Part 3, §5.5) called
 * the way crobot will call it — subscription, daily summary vs the F1 golden,
 * derived values, `since_run_id`, error codes, version guard.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  F1_1802,
  F1_DAILY_PURCHASE,
  F1_DASHBOARD,
  F1_METRICS,
  F1_PER_VARIATION,
  F1_QUALITY,
} from '../expected/f1.ts';
import { type CheckDef, type Ctx, Diff, PendingError, fail, pass, pending } from '../lib/check.ts';
import { deriveMetrics, sumByVariation } from '../lib/derive.ts';
import { type HttpResponse, field } from '../lib/http.ts';
import {
  assertBuilt,
  expPath,
  platformApi,
  queryBody,
  scopedPath,
  subscriptionBody,
  waitForReadySummary,
} from '../lib/platform-api.ts';
import {
  type DailyRow,
  type DailySummary,
  dailySummaryUnchanged,
  errorBody,
  schemaIssues,
  subscriptionResponse,
} from '../lib/schemas.ts';

interface ConfigExperiment {
  readonly experiment_id?: number;
  readonly identifier?: number;
  readonly platform_version?: string;
}

function experimentsOf(
  json: unknown,
  idKey: 'experiment_id' | 'identifier',
): Map<number, ConfigExperiment> {
  const list = (field(json, 'experiments') ?? []) as readonly ConfigExperiment[];
  return new Map(list.map((e) => [Number(e[idKey]), e]));
}

/** What crobot itself wrote (same JSON it POSTs to the config API). */
function crobotPublishedJson(ctx: Ctx): unknown {
  const file = join(
    ctx.cfg.args.crobotDir,
    'public',
    'projects',
    `${ctx.cfg.ids.projectUuid}.json`,
  );
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/**
 * PUT a subscription and turn the known not-built / cross-repo failure modes
 * into pending or a clear failure.
 */
export async function putSubscription(
  ctx: Ctx,
  experimentId: number,
  body: unknown,
): Promise<HttpResponse> {
  const res = await platformApi(ctx, {
    method: 'PUT',
    path: expPath(experimentId, 'subscription'),
    body,
  });
  assertBuilt(res, 'P4', 'PUT subscription');
  const code = field(res.json, 'error');
  if (res.status === 404 && code === 'experiment_not_found') {
    throw new Error(
      `404 experiment_not_found for ${experimentId}: the platform can't resolve it from project ${ctx.cfg.ids.projectId}'s config. ` +
        `crobot publishes the config under the project UUID (${ctx.cfg.ids.projectUuid}); the sync API receives the numeric project_id.`,
    );
  }
  if (res.status === 409 && code === 'version_mismatch') {
    const sent = experimentsOf(crobotPublishedJson(ctx), 'identifier').get(
      experimentId,
    )?.platform_version;
    if (sent === undefined)
      throw new PendingError(
        'CA',
        `409 version_mismatch: crobot's config publish has no experiments[].platform_version yet (C0)`,
      );
    throw new Error(`409 version_mismatch although crobot published platform_version=${sent}`);
  }
  if (res.status !== 200)
    throw new Error(`PUT subscription ${experimentId} → ${res.status}: ${res.text.slice(0, 300)}`);
  const parsed = subscriptionResponse.safeParse(res.json);
  if (!parsed.success)
    throw new Error(`subscription response schema: ${schemaIssues(parsed.error)}`);
  return res;
}

export function loadGolden(ctx: Ctx): readonly DailyRow[] {
  const file = join(
    ctx.cfg.args.platformDir,
    'docs',
    'reference',
    'samples',
    'f1',
    'modeled',
    'daily_summary.json',
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { rows: DailyRow[] }).rows;
}

const rowKey = (r: Pick<DailyRow, 'date' | 'variation_id' | 'metric_key'>): string =>
  `${r.date}|${r.variation_id}|${r.metric_key}`;

export function compareRows(expected: readonly DailyRow[], actual: readonly DailyRow[]): Diff {
  const d = new Diff();
  const got = new Map(actual.map((r) => [rowKey(r), r]));
  const want = new Set(expected.map(rowKey));
  for (const e of expected) {
    const a = got.get(rowKey(e));
    if (a === undefined) {
      d.truthy(`row ${rowKey(e)} present`, false);
      continue;
    }
    const k = rowKey(e);
    d.eq(`${k} visitors`, e.visitors, a.visitors)
      .eq(`${k} converted`, e.converted, a.converted)
      .eq(`${k} count`, e.count, a.count);
    d.near(`${k} sum`, e.sum, a.sum, 0.01)
      .near(`${k} sum_sq`, e.sum_sq, a.sum_sq, 0.01)
      .near(`${k} sum_sq_visitor`, e.sum_sq_visitor, a.sum_sq_visitor, 0.01);
  }
  for (const a of actual) if (!want.has(rowKey(a))) d.truthy(`unexpected row ${rowKey(a)}`, false);
  return d;
}

const summaryOf = (ctx: Ctx): DailySummary => {
  const s = ctx.facts.get('f1.summary') as DailySummary | undefined;
  if (s === undefined) throw new Error('no F1 daily summary captured');
  return s;
};

export const contractSyncChecks: readonly CheckDef[] = [
  {
    id: 'contract.auth',
    layer: 'contract',
    title: 'V8: sync API rejects a missing / wrong X-Service-Token with 401',
    owner: 'P0',
    dod: ['V8', 'PRD-006 §5.5'],
    needs: ['infra.collector'],
    async run(ctx) {
      const path = scopedPath(ctx, ctx.cfg.ids.f1, 'daily-summary');
      const none = await platformApi(ctx, { method: 'GET', path, token: null });
      assertBuilt(none, 'P0', 'GET daily-summary');
      const wrong = await platformApi(ctx, {
        method: 'GET',
        path,
        token: 'not-the-token-0000000000',
      });
      return new Diff()
        .eq('no token', 401, none.status)
        .eq('wrong token', 401, wrong.status)
        .outcome('401 on both');
    },
  },
  {
    id: 'contract.config-platform-version',
    layer: 'contract',
    title:
      'crobot config publish carries experiments[].platform_version (1717 v2, 1900 v1) and the platform keeps it',
    owner: 'CA+P0',
    dod: ['crobot §3a', 'PRD-006 §6.1 v1/v2', 'CROBOT-REQUESTS R1'],
    needs: ['smoke.config-publish'],
    async run(ctx) {
      const sent = experimentsOf(crobotPublishedJson(ctx), 'identifier');
      if (sent.get(1717)?.platform_version === undefined)
        return pending('CA', 'crobot ProjectResource has no platform_version (C0)');
      const stored = experimentsOf(ctx.facts.get('platform.config'), 'experiment_id');
      if (stored.get(1717)?.platform_version === undefined)
        return pending('P0', 'collector buildTestaConfig drops platform_version (5.1)');
      return new Diff()
        .eq('1717 sent', 'v2', sent.get(1717)?.platform_version)
        .eq('1717 stored', 'v2', stored.get(1717)?.platform_version)
        .eq('1900 stored', 'v1', stored.get(1900)?.platform_version ?? 'v1')
        .outcome('platform_version flows crobot → config API');
    },
  },
  {
    id: 'contract.subscribe-f1',
    layer: 'contract',
    title: 'PUT subscription 1717 (all F1 golden keys) → 200 {status, next_run_at}',
    owner: 'P4',
    dod: ['PRD-006 §3.1', 'V16'],
    needs: ['contract.f1-ingest', 'smoke.config-publish'],
    async run(ctx) {
      const res = await putSubscription(ctx, ctx.cfg.ids.f1, subscriptionBody(ctx, F1_METRICS));
      return pass(`200 ${res.text.slice(0, 120)}`);
    },
  },
  {
    id: 'contract.daily-summary-golden',
    layer: 'contract',
    title:
      'V2: GET daily-summary 1717 → ready; rows == f1/modeled/daily_summary.json; quality exact',
    owner: 'P4',
    dod: ['V2', 'V5', 'V17 (F1 USD→EUR)', 'PRD-006 §3.4'],
    needs: ['contract.subscribe-f1'],
    async run(ctx) {
      const summary = await waitForReadySummary(ctx, ctx.cfg.ids.f1);
      ctx.facts.set('f1.summary', summary);
      const d = compareRows(loadGolden(ctx), summary.rows);
      d.eq('quality', F1_QUALITY, summary.quality).eq(
        'report_currency',
        'EUR',
        summary.report_currency,
      );
      return d.outcome(`${summary.rows.length} rows equal the golden (run ${summary.run_id})`);
    },
  },
  {
    id: 'contract.f1-derived',
    layer: 'contract',
    title: 'V2 + V12: summed rows reproduce the F1 per-variation and V2-dashboard tables',
    owner: 'P4',
    dod: ['V2', 'V12', 'crobot §9 numbers (platform side)'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const sums = sumByVariation(summaryOf(ctx).rows);
      const d = new Diff();
      for (const variation of [100, 101] as const) {
        const v = sums.get(variation);
        if (v === undefined) {
          d.truthy(`variation ${variation} rows`, false);
          continue;
        }
        const got = deriveMetrics(v);
        for (const [k, want] of Object.entries({
          ...F1_PER_VARIATION[variation],
          ...F1_DASHBOARD[variation],
        })) {
          // The doc rounds to 6 decimals, so ±1e-6 (validation doc V2: ratios ±1e-6).
          d.near(`${variation}.${k}`, want, got[k], 1e-6);
        }
      }
      return d.outcome('F1 tables reproduced from the live rows');
    },
  },
  {
    id: 'contract.daily-purchase-rows',
    layer: 'contract',
    title: "V3: daily `purchase` rows exact (v3's D3 purchase credited to D1)",
    owner: 'P4',
    dod: ['V3'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const rows = summaryOf(ctx).rows.filter((r) => r.metric_key === 'purchase');
      const got = rows
        .map((r) => ({
          date: r.date,
          variation_id: r.variation_id,
          visitors: r.visitors,
          converted: r.converted,
        }))
        .sort((a, b) => `${a.date}${a.variation_id}`.localeCompare(`${b.date}${b.variation_id}`));
      return new Diff()
        .eq('purchase rows', F1_DAILY_PURCHASE, got)
        .outcome('4 daily purchase rows exact');
    },
  },
  {
    id: 'contract.since-run-id',
    layer: 'contract',
    title: 'V8: ?since_run_id=<current> → 200 unchanged: true, no rows',
    owner: 'P4',
    dod: ['V8', 'PRD-006 §3.4'],
    needs: ['contract.daily-summary-golden'],
    async run(ctx) {
      const runId = summaryOf(ctx).run_id;
      const res = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, ctx.cfg.ids.f1, 'daily-summary', { since_run_id: String(runId) }),
      });
      const parsed = dailySummaryUnchanged.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) {
        return fail(
          `expected 200 unchanged:true (${parsed.success ? '' : schemaIssues(parsed.error)})`,
          200,
          `${res.status} ${res.text.slice(0, 200)}`,
        );
      }
      return new Diff()
        .truthy(
          'no rows',
          field(res.json, 'rows') === undefined ||
            (field(res.json, 'rows') as unknown[]).length === 0,
        )
        .outcome('unchanged');
    },
  },
  {
    id: 'contract.1802-lifecycle',
    layer: 'contract',
    title:
      'V16 + F1 1802: subscribe → not_ready/queued/running → ready; variation 200 = 1 / 1 / €60, no 201 rows',
    owner: 'P4',
    dod: ['V16', 'V2 (exp in `exp` only)'],
    needs: ['contract.f1-ingest', 'smoke.config-publish'],
    async run(ctx) {
      const id = ctx.cfg.ids.f1Second;
      const first = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, id, 'daily-summary'),
      });
      assertBuilt(first, 'P4', 'GET daily-summary');
      const before = field(first.json, 'error');
      await putSubscription(ctx, id, subscriptionBody(ctx, ['purchase', 'revenue']));
      const afterPut = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, id, 'daily-summary'),
      });
      const initialStatus = field(afterPut.json, 'status');
      const summary = await waitForReadySummary(ctx, id);
      const v = sumByVariation(summary.rows).get(F1_1802.variation);
      return new Diff()
        .eq('before subscribe', 'not_subscribed', before)
        .truthy(
          'status right after PUT',
          ['not_ready', 'queued', 'running', 'ready'].includes(String(initialStatus)),
          String(initialStatus),
        )
        .eq('200 visitors', F1_1802.visitors, v?.visitors)
        .eq('200 purchasers', F1_1802.purchasers, v?.keys.get('purchase')?.converted)
        .near('200 revenue', F1_1802.revenue, v?.keys.get('revenue')?.sum, 0.01)
        .truthy(
          'no 201 rows',
          summary.rows.every((r) => r.variation_id !== F1_1802.absentVariation),
        )
        .outcome(`statuses: ${String(initialStatus)} → ready`);
    },
  },
  {
    id: 'contract.errors-400',
    layer: 'contract',
    title:
      'V8: 400 unknown_metric / invalid_range / invalid_currency / invalid_status / unknown_view / unknown_dimension',
    owner: 'P4',
    dod: ['V8', 'PRD-006 §5.5'],
    needs: ['smoke.config-publish'],
    async run(ctx) {
      const id = ctx.cfg.ids.f1;
      const cases: readonly [string, string, string, unknown][] = [
        ['unknown_metric', 'PUT', 'subscription', subscriptionBody(ctx, ['not_a_metric'])],
        [
          'invalid_range',
          'PUT',
          'subscription',
          subscriptionBody(ctx, ['purchase'], {
            from: '2026-10-05',
            to: '2026-10-01',
            status: 'stopped',
          }),
        ],
        [
          'invalid_currency',
          'PUT',
          'subscription',
          subscriptionBody(ctx, ['purchase'], { report_currency: 'EURO' }),
        ],
        [
          'invalid_status',
          'PUT',
          'subscription',
          subscriptionBody(ctx, ['purchase'], { status: 'paused' }),
        ],
        [
          'unknown_view',
          'POST',
          'queries',
          queryBody(ctx, {
            view: 'nope',
            from: '2026-10-01',
            to: '2026-10-03',
            metrics: ['purchase'],
          }),
        ],
        // Needs the body's project_id: without it the platform answers 400
        // invalid_body (R3; before R3 it was 404 experiment_not_found).
        [
          'unknown_dimension',
          'POST',
          'queries',
          queryBody(ctx, {
            view: 'summary',
            from: '2026-10-01',
            to: '2026-10-03',
            metrics: ['purchase'],
            dimension: 'ip_address',
          }),
        ],
      ];
      const d = new Diff();
      for (const [code, method, rest, body] of cases) {
        const res = await platformApi(ctx, { method, path: expPath(id, rest), body });
        assertBuilt(res, 'P4', `${method} ${rest}`);
        const parsed = errorBody.safeParse(res.json);
        d.eq(`${code} status`, 400, res.status).eq(
          `${code} code`,
          code,
          parsed.success ? parsed.data.error : res.text.slice(0, 80),
        );
      }
      return d.outcome('all six 400 codes');
    },
  },
  {
    id: 'contract.errors-404',
    layer: 'contract',
    title: 'V8: 404 experiment_not_found / not_subscribed / query_not_found',
    owner: 'P4',
    dod: ['V8', 'PRD-006 §5.5'],
    needs: ['smoke.config-publish'],
    async run(ctx) {
      const unknown = await platformApi(ctx, {
        method: 'PUT',
        path: expPath(999999, 'subscription'),
        body: subscriptionBody(ctx, ['purchase']),
      });
      assertBuilt(unknown, 'P4', 'PUT subscription');
      const notSub = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, ctx.cfg.ids.f3, 'daily-summary'),
      });
      const noQuery = await platformApi(ctx, {
        method: 'GET',
        path: scopedPath(ctx, ctx.cfg.ids.f1, `queries/${'0'.repeat(64)}`),
      });
      const code = (r: HttpResponse): unknown => field(r.json, 'error');
      return new Diff()
        .eq('unknown experiment', [404, 'experiment_not_found'], [unknown.status, code(unknown)])
        .eq(
          'unsubscribed daily-summary (1903 before crobot subscribes)',
          [404, 'not_subscribed'],
          [notSub.status, code(notSub)],
        )
        .eq('unknown query', [404, 'query_not_found'], [noQuery.status, code(noQuery)])
        .outcome('three 404 codes');
    },
  },
  {
    id: 'contract.version-409',
    layer: 'contract',
    title: 'V8 + crobot §3a: v1 experiment 1900 → 409 version_mismatch',
    owner: 'P4',
    dod: ['V8', 'crobot §3a guards'],
    needs: ['smoke.config-publish'],
    async run(ctx) {
      const res = await platformApi(ctx, {
        method: 'PUT',
        path: expPath(ctx.cfg.ids.v1Experiment, 'subscription'),
        body: subscriptionBody(ctx, ['purchase']),
      });
      assertBuilt(res, 'P4', 'PUT subscription');
      return new Diff()
        .eq('status + code', [409, 'version_mismatch'], [res.status, field(res.json, 'error')])
        .outcome('409');
    },
  },
];
