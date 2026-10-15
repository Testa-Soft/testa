/**
 * Modeler process (task 5.15) against real ClickHouse + real Redis: scheduler,
 * queue, locks, run lifecycle, metric_daily, retries, query jobs, webhooks,
 * stop → final run, once mode. F1 rows must equal the golden.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p4 \
 *   REDIS_URL=redis://localhost:6380 bun test src/modeler
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DailyRow,
  MetricKey,
  ProjectConfig,
  SummaryResult,
  WebhookPayload,
} from '@testa-platform/shared-types';
import type { Server } from 'bun';
import IORedis, { type Redis } from 'ioredis';
import { REDIS_TEST_DB, REDIS_TEST_URL, deleteByPrefix } from '../../__test-utils__/redis.ts';
import { fileConfigStore } from '../../config/store.ts';
import { insertRows } from '../../db/clickhouse.ts';
import type { ModelerContext } from '../context.ts';
import { modelerKeys } from '../keys.ts';
import { runOnce } from '../main.ts';
import { readQuery, submitQuery } from '../query-jobs.ts';
import { PRIORITY, acquireLock, enqueue } from '../queue.ts';
import { readRunState } from '../run-state.ts';
import { tick } from '../scheduler.ts';
import { chDateTime, writeSubscription } from '../subscriptions.ts';
import { createWebhookSender, sign } from '../webhook.ts';
import { drain } from '../worker.ts';
import {
  database,
  live,
  prepareDatabase,
  randomExperimentId,
  randomProjectId,
  readGolden,
  run,
  seedOracleFx,
  seedSample,
} from './live.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const F1 = readGolden<SummaryResult>('f1', 'daily_summary.json');
const KEYS = [...new Set(F1.rows.map((r) => r.metric_key))] as MetricKey[];
const SECRET = 'test-webhook-secret-0123456789';
const PREFIX = `prd006:p4:test-${randomUUID()}:`;

interface Hook {
  path: string;
  body: string;
  ts: string;
  signature: string;
}

let redis: Redis;
let server: Server;
const hooks: Hook[] = [];
let failNextHooks = 0;
const created: { projectId: number; experimentId: number }[] = [];
const configDir = mkdtempSync(join(tmpdir(), 'modeler-config-'));

function projectConfig(projectId: number, experimentId: number): ProjectConfig {
  return {
    project_id: projectId,
    experiments: [
      {
        experiment_id: experimentId,
        status: 'active',
        platform_version: 'v2',
        rules: [],
        goals: [],
        traffic_allocation: 100,
        variations: [
          { variation_id: 100, weight: 50, changes: [] },
          { variation_id: 101, weight: 50, changes: [] },
        ],
      },
    ],
  } as unknown as ProjectConfig;
}

function makeCtx(overrides: Partial<ModelerContext> = {}): ModelerContext {
  return {
    redis,
    keys: modelerKeys(PREFIX),
    query: run,
    insert: insertRows,
    configStore: fileConfigStore(configDir),
    webhook: createWebhookSender({
      url: `http://localhost:${server.port}`,
      secret: SECRET,
      retryDelaysSec: [0.05, 0.05],
    }),
    settings: {
      concurrency: 2,
      lockTtlSec: 60,
      retryDelaysSec: [0, 0, 0],
      queryTtlSec: 3600,
      maxRunAgeSec: 86_400,
      pollMs: 50,
    },
    now: Date.now,
    log: () => {},
    ...overrides,
  };
}

/** A fresh project with the F1 fixture, its config and a running subscription. */
async function f1Experiment(): Promise<{ projectId: number; experimentId: number }> {
  const projectId = randomProjectId();
  const experimentId = randomExperimentId();
  await seedSample('f1', projectId, experimentId);
  created.push({ projectId, experimentId });
  await fileConfigStore(configDir).put(String(projectId), projectConfig(projectId, experimentId));
  return { projectId, experimentId };
}

async function subscribe(
  projectId: number,
  experimentId: number,
  status: 'running' | 'stopped' = 'running',
): Promise<string> {
  const updatedAt = chDateTime(new Date());
  await writeSubscription(insertRows, {
    projectId,
    experimentId,
    status,
    from: '2026-10-01',
    to: '2026-10-03',
    reportCurrency: 'EUR',
    metrics: KEYS,
    updatedAt,
  });
  return updatedAt;
}

async function storedRows(projectId: number, runId: string): Promise<DailyRow[]> {
  const rows = await run<Record<string, string | number>>(
    `SELECT toString(date) AS d, variation_id, metric_key, visitors, converted, count, sum, sum_sq, sum_sq_visitor, is_final
     FROM metric_daily WHERE project_id = {p:UInt64} AND run_id = {r:String}`,
    { p: projectId, r: runId },
  );
  return rows.map((r) => ({
    date: String(r.d),
    variation_id: Number(r.variation_id),
    metric_key: r.metric_key as MetricKey,
    visitors: Number(r.visitors),
    converted: Number(r.converted),
    count: Number(r.count),
    sum: Number(r.sum),
    sum_sq: Number(r.sum_sq),
    sum_sq_visitor: Number(r.sum_sq_visitor),
  }));
}

const sortRows = (rows: DailyRow[]) =>
  [...rows].sort((a, b) =>
    `${a.date}|${a.variation_id}|${a.metric_key}`.localeCompare(
      `${b.date}|${b.variation_id}|${b.metric_key}`,
    ),
  );

describe.skipIf(!liveRedis)(`modeler (live ClickHouse db=${database} + Redis)`, () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, {
      db: REDIS_TEST_DB,
      maxRetriesPerRequest: 1,
    });
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        hooks.push({
          path: new URL(req.url).pathname,
          body,
          ts: req.headers.get('x-testa-timestamp') ?? '',
          signature: req.headers.get('x-testa-signature') ?? '',
        });
        if (failNextHooks > 0) {
          failNextHooks--;
          return new Response('boom', { status: 500 });
        }
        return new Response('ok');
      },
    });
    await prepareDatabase();
    await seedOracleFx('2026-10-01', '2026-10-03');
  });

  afterAll(async () => {
    // Retire this run's subscriptions so later runs' scheduler ticks ignore them.
    for (const { projectId, experimentId } of created) {
      await writeSubscription(insertRows, {
        projectId,
        experimentId,
        status: 'deleted',
        from: '2026-10-01',
        to: '2026-10-03',
        reportCurrency: 'EUR',
        metrics: KEYS,
        updatedAt: chDateTime(new Date(Date.now() + 1000)),
      });
    }
    await deleteByPrefix(redis, PREFIX);
    await redis.quit();
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  it('subscription → one run → metric_daily rows equal the F1 golden; idle tick enqueues nothing; new event → new run', async () => {
    const ctx = makeCtx();
    const { projectId, experimentId } = await f1Experiment();
    await subscribe(projectId, experimentId);

    expect(await tick(ctx)).toContainEqual({ projectId, experimentId });
    expect((await readRunState(redis, ctx.keys.run(projectId, experimentId))).status).toBe(
      'queued',
    );
    expect(await drain(ctx)).toBeGreaterThanOrEqual(1);

    const state = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(state.status).toBe('ready');
    expect(state.last_ready_run_id).toMatch(/^r_[0-9A-Z]{26}$/);
    expect(state.quality).toEqual(F1.quality);
    expect(state.data_through).toBe('2026-10-03T09:20:00.180Z');
    expect(sortRows(await storedRows(projectId, state.last_ready_run_id))).toEqual(
      sortRows(F1.rows),
    );

    expect(await tick(ctx)).not.toContainEqual({ projectId, experimentId });

    await insertRows('events', [
      {
        event_id: randomUUID(),
        client_ts: '2026-10-03 11:00:00.000',
        server_ts: chDateTime(new Date()),
        project_id: projectId,
        visitor_id: 'v1',
        session_id: 's-v1',
        event_name: 'page_view',
        url: 'https://shop.example/',
        exp_ids: [experimentId],
        exp_var_ids: [100],
        exp_session_starts: [1790848800],
      },
    ]);
    expect(await tick(ctx)).toContainEqual({ projectId, experimentId });
    await drain(ctx);
    const next = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(next.status).toBe('ready');
    expect(next.last_ready_run_id).not.toBe(state.last_ready_run_id);
    await ctx.webhook.drain();
    const ready = hooks
      .filter((h) => h.path === '/api/webhooks/analytics/summary-ready')
      .map((h) => JSON.parse(h.body) as WebhookPayload);
    expect(
      ready.some(
        (p) =>
          p.event === 'summary-ready' &&
          p.run_id === next.last_ready_run_id &&
          p.project_id === projectId,
      ),
    ).toBe(true);
  });

  it('lock: a held lock defers the job, and two workers never run the same experiment', async () => {
    const ctx = makeCtx();
    const { projectId, experimentId } = await f1Experiment();
    await subscribe(projectId, experimentId);
    const job = { kind: 'refresh' as const, projectId, experimentId };

    await acquireLock(redis, ctx.keys.lock(projectId, experimentId), 'someone-else', 60);
    await enqueue(redis, ctx.keys, job, PRIORITY.high, Date.now());
    await drain(ctx);
    expect(
      (await readRunState(redis, ctx.keys.run(projectId, experimentId))).last_ready_run_id,
    ).toBe('');
    expect(await redis.zcard(ctx.keys.delayed)).toBeGreaterThanOrEqual(1);
    await redis.del(ctx.keys.lock(projectId, experimentId));
    await redis.zrem(ctx.keys.delayed, `refresh:${projectId}:${experimentId}`);

    // Enqueue twice (deduped) and race 4 workers: exactly one run lands.
    await enqueue(redis, ctx.keys, job, PRIORITY.scheduled, Date.now());
    await enqueue(redis, ctx.keys, job, PRIORITY.high, Date.now());
    expect(await redis.zcard(ctx.keys.queue)).toBe(1);
    await Promise.all([drain(ctx), drain(ctx)]);
    const [{ runs }] = (await run<{ runs: string }>(
      'SELECT uniqExact(run_id) AS runs FROM metric_daily WHERE project_id = {p:UInt64}',
      { p: projectId },
    )) as [{ runs: string }];
    expect(Number(runs)).toBe(1);
  });

  it('failure: 1 attempt + 3 retries → failed; the previous run stays readable', async () => {
    const good = makeCtx();
    const { projectId, experimentId } = await f1Experiment();
    await subscribe(projectId, experimentId);
    await tick(good);
    await drain(good);
    const before = await readRunState(redis, good.keys.run(projectId, experimentId));
    expect(before.status).toBe('ready');

    let calls = 0;
    const broken = makeCtx({
      query: async (sql, params) => {
        if (sql.includes('FROM exposures')) {
          // Count attempts by the daily-rows query only (quality runs alongside it).
          if (sql.includes('dv_first')) calls++;
          throw new Error('injected failure');
        }
        return run(sql, params);
      },
    });
    await enqueue(
      redis,
      broken.keys,
      { kind: 'refresh', projectId, experimentId },
      PRIORITY.high,
      Date.now(),
    );
    await drain(broken);
    const after = await readRunState(redis, broken.keys.run(projectId, experimentId));
    expect(after.status).toBe('failed');
    expect(after.error).toContain('injected failure');
    expect(calls).toBe(4);
    expect(after.last_ready_run_id).toBe(before.last_ready_run_id);
    expect((await storedRows(projectId, after.last_ready_run_id)).length).toBe(F1.rows.length);
  });

  it('webhook: signature verifies with the shared secret; a 500 is retried', async () => {
    const sender = createWebhookSender({
      url: `http://localhost:${server.port}/`,
      secret: SECRET,
      retryDelaysSec: [0.05],
    });
    const runId = `r_${randomUUID()}`;
    failNextHooks = 1;
    sender.send({
      event: 'summary-ready',
      project_id: 1,
      experiment_id: 1,
      run_id: runId,
      computed_at: '2026-10-15T09:30:12.000Z',
      data_through: '2026-10-15T09:29:58.000Z',
    });
    await sender.drain();
    const mine = hooks.filter((h) => h.body.includes(runId));
    expect(mine).toHaveLength(2);
    for (const h of mine) {
      expect(h.path).toBe('/api/webhooks/analytics/summary-ready');
      expect(h.signature).toBe(sign(SECRET, h.ts, h.body));
      expect(h.signature).not.toBe(sign('wrong-secret-0123456789', h.ts, h.body));
    }
  });

  it('query jobs: same body twice → one job; result stored; query-ready webhook', async () => {
    const ctx = makeCtx();
    const { projectId, experimentId } = await f1Experiment();
    await subscribe(projectId, experimentId);
    const body = {
      view: 'summary' as const,
      project_id: projectId,
      from: '2026-10-01',
      to: '2026-10-03',
      metrics: ['purchase', 'revenue'] as MetricKey[],
      dimension: 'device_type' as const,
    };
    const a = await submitQuery(ctx, experimentId, body);
    const b = await submitQuery(ctx, experimentId, { ...body, refresh: true });
    expect(b).toBe(a);
    expect(await redis.zrange(ctx.keys.queue, 0, -1)).toEqual([`query:${a}`]);
    await drain(ctx);
    await ctx.webhook.drain();

    const stored = await readQuery(ctx, a);
    expect(stored).not.toBeNull();
    expect(stored === 'expired' ? null : stored?.status).toBe('ready');
    const result = (stored as { result: SummaryResult }).result;
    expect(result.dimension).toBe('device_type');
    expect(result.quality).toEqual(F1.quality);
    expect(await redis.ttl(ctx.keys.query(a))).toBeGreaterThan(3500);
    expect(hooks.some((h) => h.path.endsWith('/query-ready') && h.body.includes(a))).toBe(true);
    expect(await readQuery(ctx, 'f'.repeat(64))).toBeNull();
  });

  it('stopped → one final run with is_final = 1, then never again; once mode reports it', async () => {
    const ctx = makeCtx();
    const { projectId, experimentId } = await f1Experiment();
    const updatedAt = await subscribe(projectId, experimentId, 'stopped');
    const summary = await runOnce(ctx);
    expect(summary.enqueued).toContainEqual({ projectId, experimentId });
    expect(summary.failed).not.toContainEqual({ projectId, experimentId });
    const state = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(state.final_for).toBe(updatedAt);
    const [{ finals }] = (await run<{ finals: string }>(
      'SELECT countIf(is_final = 1) AS finals FROM metric_daily WHERE project_id = {p:UInt64} AND run_id = {r:String}',
      { p: projectId, r: state.last_ready_run_id },
    )) as [{ finals: string }];
    expect(Number(finals)).toBe(F1.rows.length);
    expect((await runOnce(ctx)).enqueued).not.toContainEqual({ projectId, experimentId });
  });
});
