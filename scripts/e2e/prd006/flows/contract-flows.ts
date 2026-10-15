/**
 * API contract and sync lifecycle (006-validation.md V8, V16) over real HTTP.
 * V8 runs on its own project (CONTRACT) so the 429 rate-limit probe can't
 * starve other flows; V16 drives F1's experiment 1802 through delete →
 * subscribe → ready, a new event, an injected modeler failure, the webhook
 * and query dedup.
 */

import { signWebhook } from '../../cross/lib/hmac.ts';
import type { WireEvent } from '../../cross/shared/f1-wire.ts';
import { uuidFor } from '../../cross/shared/ids.ts';
import { CONTRACT, FIXTURES } from '../config.ts';
import { F1_FROM, F1_TO } from '../fixtures/f1.ts';
import { ingestProject } from '../ingest.ts';
import { QUERY_TTL_SEC, restartProc } from '../stack.ts';
import type { SummaryBody } from './api.ts';
import { type CheckFn, Diff, F1_KEYS, type FlowCtx, fact, fail, pass } from './types.ts';

const C = CONTRACT;
const exp = (id: number, rest: string) => `/api/v1/experiments/${id}${rest}`;
const subBody = (extra: Record<string, unknown> = {}) => ({
  project_id: C.projectId,
  status: 'running',
  from: '2026-10-01',
  to: '2026-10-03',
  report_currency: 'EUR',
  metrics: ['purchase'],
  ...extra,
});
const queryBody = (extra: Record<string, unknown> = {}) => ({
  view: 'summary',
  project_id: C.projectId,
  from: '2026-10-01',
  to: '2026-10-03',
  report_currency: 'EUR',
  metrics: ['purchase'],
  ...extra,
});
const errorOf = (json: unknown): unknown => (json as { error?: unknown } | null)?.error;

export async function v8(ctx: FlowCtx, check: CheckFn): Promise<void> {
  const { api } = ctx;
  for (const id of [C.emptyV2, C.legacyV1, C.missing]) api.remember(id, C.projectId);

  await check('401 for a missing and a wrong service token', async () => {
    const d = new Diff();
    for (const token of [null, 'wrong-token-0123456789']) {
      const res = await api.call('GET', api.scoped(C.emptyV2, '/daily-summary'), undefined, token);
      d.eq(`token ${token ?? 'missing'}`, [401, 'unauthorized'], [res.status, errorOf(res.json)]);
    }
    const stats = await api.stats({}, null);
    d.eq('stats without token', 401, stats.status);
    return d.outcome('401s');
  });

  await check('404 not_subscribed before subscribing', async () => {
    const res = await api.call('GET', api.scoped(C.emptyV2, '/daily-summary'));
    return new Diff()
      .eq('status, error', [404, 'not_subscribed'], [res.status, errorOf(res.json)])
      .outcome('404');
  });

  await check('every §5.5 400 code', async () => {
    const d = new Diff();
    const put = (b: object) => api.call('PUT', exp(C.emptyV2, '/subscription'), b);
    const post = (b: object) => api.call('POST', exp(C.emptyV2, '/queries'), b);
    const cases: [string, Promise<{ status: number; json: unknown }>][] = [
      ['unknown_metric', put(subBody({ metrics: ['nope'] }))],
      ['invalid_currency', put(subBody({ report_currency: 'EURO' }))],
      ['invalid_status', put(subBody({ status: 'paused' }))],
      ['invalid_range', put(subBody({ from: '2026-10-05', to: '2026-10-01' }))],
      ['unknown_dimension', post(queryBody({ dimension: 'ip' }))],
      ['unknown_view', post(queryBody({ view: 'heatmap' }))],
    ];
    for (const [code, p] of cases) {
      const res = await p;
      d.eq(code, [400, code], [res.status, errorOf(res.json)]);
    }
    return d.outcome('6 codes');
  });

  await check('404 experiment_not_found / query_not_found, 409 version_mismatch', async () => {
    const d = new Diff();
    const missing = await api.call('PUT', exp(C.missing, '/subscription'), subBody());
    d.eq(
      'experiment_not_found',
      [404, 'experiment_not_found'],
      [missing.status, errorOf(missing.json)],
    );
    const q = await api.call('GET', api.scoped(C.emptyV2, `/queries/${'0'.repeat(64)}`));
    d.eq('query_not_found', [404, 'query_not_found'], [q.status, errorOf(q.json)]);
    const v1 = await api.call('PUT', exp(C.legacyV1, '/subscription'), subBody());
    d.eq('version_mismatch', [409, 'version_mismatch'], [v1.status, errorOf(v1.json)]);
    return d.outcome('404 / 409');
  });

  await check(
    'subscribed experiment with no exposures → ready + empty rows; since_run_id → unchanged',
    async () => {
      const put = await api.call('PUT', exp(C.emptyV2, '/subscription'), subBody());
      if (put.status !== 200) return fail(`PUT → ${put.status}: ${put.text.slice(0, 200)}`);
      const ready = await api.waitReady(C.emptyV2);
      const again = await api.summary(C.emptyV2, ready.run_id ?? '');
      return new Diff()
        .eq('rows', [], ready.rows)
        .eq('unchanged', true, again.body.unchanged)
        .outcome(`ready, run ${ready.run_id ?? '?'}`);
    },
  );

  await check(
    `410 expired after the query TTL (harness TTL ${QUERY_TTL_SEC} s; production 1 h)`,
    async () => {
      const accepted = await api.call(
        'POST',
        exp(C.emptyV2, '/queries'),
        queryBody({ to: '2026-10-02' }),
      );
      const id = String((accepted.json as { query_id?: string }).query_id);
      await api.query(C.emptyV2, queryBody({ to: '2026-10-02' }));
      await Bun.sleep((QUERY_TTL_SEC + 3) * 1000);
      const res = await api.call('GET', api.scoped(C.emptyV2, `/queries/${id}`));
      return new Diff()
        .eq('status, error', [410, 'expired'], [res.status, errorOf(res.json)])
        .outcome('410');
    },
  );

  await check('429 too_many_queries after 60 POSTs / min per project', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) {
      const day = String(1 + (i % 28)).padStart(2, '0');
      const res = await api.call(
        'POST',
        exp(C.emptyV2, '/queries'),
        queryBody({ from: `2026-0${1 + Math.floor(i / 28)}-${day}`, to: '2026-10-03' }),
      );
      statuses.push(res.status);
      if (res.status === 429) {
        return errorOf(res.json) === 'too_many_queries'
          ? pass(`429 on POST #${i + 1}`)
          : fail('error code', 'too_many_queries', res.json);
      }
    }
    return fail('no 429 within 62 POSTs', 429, [...new Set(statuses)]);
  });
}

// ─── V16 ────────────────────────────────────────────────────────────────────

const LIFE = FIXTURES.F1.experiments[1];
const P1 = FIXTURES.F1.projectId;

/** Poll daily-summary, recording (status, rows) until `done` or timeout. */
async function observe(ctx: FlowCtx, until: (b: SummaryBody) => boolean, ms = 120_000) {
  const seen: { status: string; rows: number; run: string | null }[] = [];
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { body } = await ctx.api.summary(LIFE);
    const last = seen.at(-1);
    if (!last || last.status !== body.status || last.run !== body.run_id) {
      seen.push({ status: body.status, rows: body.rows?.length ?? 0, run: body.run_id });
    }
    if (until(body)) return { seen, body };
    await Bun.sleep(100);
  }
  return { seen, body: null };
}

export async function v16(ctx: FlowCtx, check: CheckFn): Promise<void> {
  const sub = { projectId: P1, from: F1_FROM, to: null, metrics: F1_KEYS };

  await check('subscribe → not_ready → queued/running → ready', async () => {
    await ctx.api.call('DELETE', ctx.api.scoped(LIFE, '/subscription'), { project_id: P1 });
    const put = await ctx.api.subscribe(LIFE, sub);
    const first = put.json as { status?: string };
    const { seen, body } = await observe(ctx, (b) => b.status === 'ready');
    const statuses = [String(first.status), ...seen.map((s) => s.status)];
    return new Diff()
      .truthy(
        'starts not_ready / queued / running',
        ['not_ready', 'queued', 'running'].includes(statuses[0] ?? ''),
        statuses.join(' → '),
      )
      .truthy('ends ready', body?.status === 'ready')
      .outcome(statuses.join(' → '));
  });

  await check('a new event → new run_id; old rows served while running', async () => {
    const before = await ctx.api.waitReady(LIFE);
    // v5's real experiment_view for 1802 as the template (all ingest fields), as a later page_view.
    const template = fact<WireEvent[]>(ctx, 'f1.wire').find(
      (e) => e.visitor_id === 'v5' && e.event_name === 'experiment_view',
    );
    if (!template) return fail('v5 experiment_view missing from F1');
    const ts = template.client_ts + 20 * 60_000;
    const event: WireEvent = {
      ...template,
      event_id: uuidFor(`v16|${Date.now()}`),
      event_name: 'page_view',
      client_ts: ts,
      // The edge stamps server_ts at receipt; the scheduler's "new data" test is max(server_ts).
      server_ts: Date.now(),
      in_experiment: 1,
    };
    await ingestProject(ctx.cfg, P1, [event]);
    const { seen, body } = await observe(
      ctx,
      (b) => b.status === 'ready' && b.run_id !== before.run_id,
    );
    const notReady = seen.filter((s) => s.status !== 'ready');
    return new Diff()
      .truthy(
        'new run_id',
        body !== null && body.run_id !== before.run_id,
        `${before.run_id} → ${body?.run_id}`,
      )
      .truthy(
        'old rows while queued/running',
        notReady.every((s) => s.rows > 0),
      )
      .outcome(
        notReady.length
          ? `observed ${notReady.map((s) => s.status).join(', ')} with old rows`
          : 'new run (running state too fast to observe)',
      );
  });

  await check('injected failure ×3 → failed, old rows still served', async () => {
    const before = await ctx.api.waitReady(LIFE);
    await restartProc(ctx.cfg, 'modeler', { CLICKHOUSE_DATABASE: 'prd006_missing_db' });
    try {
      await ctx.api.subscribe(LIFE, { ...sub, metrics: ['purchase', 'revenue'] });
      const { seen, body } = await observe(ctx, (b) => b.status === 'failed', 90_000);
      return new Diff()
        .truthy('status failed', body?.status === 'failed', seen.map((s) => s.status).join(' → '))
        .truthy('old rows served', (body?.rows.length ?? 0) > 0)
        .eq('run_id unchanged', before.run_id, body?.run_id)
        .outcome('failed with old rows');
    } finally {
      await restartProc(ctx.cfg, 'modeler', {});
      await ctx.api.subscribe(LIFE, sub);
      await ctx.api.waitReady(LIFE, { timeoutMs: 120_000 }).catch(() => undefined);
    }
  });

  await check('webhook summary-ready received with a valid signature', async () => {
    const hooks = ctx.webhooks.received.filter((h) => h.path.endsWith('/summary-ready'));
    if (hooks.length === 0) return fail('no summary-ready webhook received', '≥ 1', 0);
    const bad = hooks.filter((h) => {
      const ts = Number(h.headers['x-testa-timestamp']);
      return (
        signWebhook(h.body, ctx.cfg.secrets.webhook, ts)['x-testa-signature'] !==
        h.headers['x-testa-signature']
      );
    });
    return bad.length === 0
      ? pass(`${hooks.length} signed webhook(s)`)
      : fail('bad signatures', 0, bad.length);
  });

  await check('query dedup: same body → same query_id; refresh keeps it', async () => {
    const body = {
      view: 'summary',
      project_id: P1,
      from: F1_FROM,
      to: F1_TO,
      report_currency: 'EUR',
      metrics: ['purchase'],
    };
    const a = await ctx.api.call('POST', exp(LIFE, '/queries'), body);
    const b = await ctx.api.call('POST', exp(LIFE, '/queries'), body);
    const c = await ctx.api.call('POST', exp(LIFE, '/queries'), { ...body, refresh: true });
    const id = (r: { json: unknown }) => (r.json as { query_id?: string }).query_id;
    return new Diff()
      .truthy(
        'ids equal',
        id(a) !== undefined && id(a) === id(b) && id(b) === id(c),
        `${id(a)} ${id(b)} ${id(c)}`,
      )
      .outcome('deduped');
  });
}
