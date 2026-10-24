/**
 * Sync API (task 5.8) over real HTTP against real ClickHouse + Redis, with the
 * real modeler doing the runs: status transitions, since_run_id, error codes,
 * limits, query lifecycle, response shapes (PRD §3.4–3.5), p95 latency.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p4 \
 *   REDIS_URL=redis://localhost:6380 bun test src/sync
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricKey, ProjectConfig, SummaryResult } from '@testa-platform/shared-types';
import type { Server } from 'bun';
import { Hono } from 'hono';
import IORedis, { type Redis } from 'ioredis';
import { REDIS_TEST_DB, REDIS_TEST_URL, deleteByPrefix } from '../../__test-utils__/redis.ts';
import { fileConfigStore } from '../../config/store.ts';
import { insertRows } from '../../db/clickhouse.ts';
import {
  live,
  prepareDatabase,
  randomExperimentId,
  randomProjectId,
  readGolden,
  run,
  seedOracleFx,
  seedSample,
} from '../../modeler/__tests__/live.ts';
import { modelerKeys } from '../../modeler/keys.ts';
import { PRIORITY } from '../../modeler/queue.ts';
import { requestRefresh } from '../../modeler/scheduler.ts';
import { chDateTime, writeSubscription } from '../../modeler/subscriptions.ts';
import { noWebhooks } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import type { SyncContext } from '../context.ts';
import { makeSyncRouter } from '../router.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const TOKEN = 'sync-test-token-0123456789';
const PREFIX = `prd006:p4:test-${randomUUID()}:`;
const F1 = readGolden<SummaryResult>('f1', 'daily_summary.json');
const KEYS = [...new Set(F1.rows.map((r) => r.metric_key))] as MetricKey[];

let redis: Redis;
let server: Server;
let base: string;
const configDir = mkdtempSync(join(tmpdir(), 'sync-config-'));
const created: { projectId: number; experimentId: number }[] = [];

/** Lets a test hold a modeler run open (status `running`) until released. */
let gate: Promise<void> | null = null;

function ctxWith(query = run): SyncContext {
  return {
    redis,
    keys: modelerKeys(PREFIX),
    query,
    insert: insertRows,
    configStore: fileConfigStore(configDir),
    webhook: noWebhooks,
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
    intervalSec: 900,
  };
}

/** The router's context; its queries wait on `gate` when one is set. Built in beforeAll. */
let gated: SyncContext;

function config(
  projectId: number,
  experiments: { id: number; version?: 'v1' | 'v2' }[],
): ProjectConfig {
  return {
    project_id: projectId,
    experiments: experiments.map(({ id, version }) => ({
      experiment_id: id,
      status: 'active',
      rules: [],
      goals: [],
      traffic_allocation: 100,
      ...(version ? { platform_version: version } : {}),
      variations: [
        { variation_id: 100, weight: 50, changes: [] },
        { variation_id: 101, weight: 50, changes: [] },
      ],
    })),
  } as unknown as ProjectConfig;
}

async function setup(sample: 'f1' | 'demo' | null = 'f1') {
  const projectId = randomProjectId();
  const experimentId = randomExperimentId();
  const v1Id = randomExperimentId();
  if (sample) await seedSample(sample, projectId, experimentId);
  await fileConfigStore(configDir).put(
    String(projectId),
    config(projectId, [
      { id: experimentId, version: 'v2' },
      { id: v1Id, version: 'v1' },
    ]),
  );
  created.push({ projectId, experimentId });
  return { projectId, experimentId, v1Id };
}

const headers = { 'X-Service-Token': TOKEN, 'content-type': 'application/json' };

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1/experiments${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (await res.json()) as Record<string, any>,
  };
}

const subscription = (projectId: number, extra: object = {}) => ({
  project_id: projectId,
  status: 'running',
  from: '2026-10-01',
  to: '2026-10-03',
  report_currency: 'EUR',
  metrics: KEYS,
  ...extra,
});

async function waitFor(fn: () => Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sortRows = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) =>
    `${a.date}|${a.variation_id}|${a.metric_key}`.localeCompare(
      `${b.date}|${b.variation_id}|${b.metric_key}`,
    ),
  );

describe.skipIf(!liveRedis)('sync API (live ClickHouse + Redis, real HTTP)', () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, {
      db: REDIS_TEST_DB,
      maxRetriesPerRequest: 1,
    });
    gated = ctxWith(async (sql, params) => {
      if (gate && sql.includes('dv_first')) await gate;
      return run(sql, params);
    });
    const app = new Hono();
    app.route('/api/v1/experiments', makeSyncRouter({ serviceToken: TOKEN, context: () => gated }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${server.port}`;
    await prepareDatabase();
    await seedOracleFx('2026-10-01', '2026-10-15');
  });

  afterAll(async () => {
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

  it('status transitions: not_ready → running → ready → unchanged → queued/running with old rows → failed with old rows', async () => {
    const { projectId, experimentId } = await setup();
    expect(
      (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`)).status,
    ).toBe(404);

    const put = await call('PUT', `/${experimentId}/subscription`, subscription(projectId));
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ status: 'not_ready', next_run_at: expect.any(String) });

    const notReady = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(notReady.status).toBe(200);
    expect(notReady.body).toMatchObject({ status: 'not_ready', run_id: null, rows: [] });
    expect(Number(notReady.retryAfter)).toBe(notReady.body.retry_after);
    expect(notReady.body.retry_after).toBeGreaterThanOrEqual(10);

    // Hold the run open → running (no finished run yet → no rows).
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    const running = drain(gated);
    await waitFor(
      async () =>
        (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`)).body
          .status === 'running',
    );
    expect(
      (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`)).body.rows,
    ).toEqual([]);
    release();
    gate = null;
    await running;

    const ready = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.run_id).toMatch(/^r_/);
    expect(ready.body.quality).toEqual(F1.quality);
    expect(sortRows(ready.body.rows)).toEqual(
      sortRows(F1.rows as unknown as Record<string, unknown>[]),
    );
    // R2: upsell units (validation F1 V2: units sold 4 = 1 + 2 + 1 upsell).
    const upsellUnits = (v: number): number =>
      (ready.body.rows as { variation_id: number; metric_key: string; count: number }[])
        .filter((r) => r.variation_id === v && r.metric_key === 'units_upsell')
        .reduce((n, r) => n + r.count, 0);
    expect([upsellUnits(100), upsellUnits(101)]).toEqual([0, 1]);
    const firstRun = ready.body.run_id as string;

    const unchanged = await call(
      'GET',
      `/${experimentId}/daily-summary?project_id=${projectId}&since_run_id=${firstRun}`,
    );
    expect(unchanged.body).toMatchObject({
      status: 'ready',
      run_id: firstRun,
      unchanged: true,
      rows: [],
    });

    // New refresh queued → queued, old rows still served.
    await requestRefresh(gated, projectId, experimentId, PRIORITY.high);
    const queued = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(queued.body.status).toBe('queued');
    expect(queued.body.run_id).toBe(firstRun);
    expect(queued.body.rows.length).toBe(F1.rows.length);

    gate = new Promise<void>((r) => {
      release = r;
    });
    const second = drain(gated);
    await waitFor(
      async () =>
        (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`)).body
          .status === 'running',
    );
    const runningOld = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(runningOld.body.run_id).toBe(firstRun);
    expect(runningOld.body.rows.length).toBe(F1.rows.length);
    release();
    gate = null;
    await second;
    const secondRun = (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`))
      .body.run_id;
    expect(secondRun).not.toBe(firstRun);

    // Failing refresh (after retries) → failed, last good run still served.
    const broken = ctxWith(async (sql, params) => {
      if (sql.includes('dv_first')) throw new Error('boom');
      return run(sql, params);
    });
    await requestRefresh(broken, projectId, experimentId, PRIORITY.high);
    await drain(broken);
    const failed = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.run_id).toBe(secondRun);
    expect(failed.body.rows.length).toBe(F1.rows.length);
  });

  it('response bodies have the PRD §3.4 shape', async () => {
    const { projectId, experimentId } = await setup();
    await call(
      'PUT',
      `/${experimentId}/subscription`,
      subscription(projectId, { metrics: ['purchase', 'revenue'] }),
    );
    await drain(gated);
    const { body } = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    for (const k of [
      'status',
      'run_id',
      'computed_at',
      'data_through',
      'next_run_at',
      'retry_after',
      'from',
      'to',
      'report_currency',
      'quality',
      'rows',
    ]) {
      expect(body).toHaveProperty(k);
    }
    expect(body.from).toBe('2026-10-01');
    expect(body.to).toBe('2026-10-03');
    expect(body.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Object.keys(body.rows[0]).sort()).toEqual(
      [
        'converted',
        'count_sq_visitor',
        'count',
        'date',
        'metric_key',
        'sum',
        'sum_sq',
        'sum_sq_visitor',
        'variation_id',
        'visitors',
      ].sort(),
    );
    expect(Object.keys(body.quality).sort()).toEqual([
      'multi_variation_visitors',
      'variation_mismatch_events',
    ]);
  });

  it('error codes: 404 experiment_not_found, 409 version_mismatch, 404 not_subscribed, DELETE', async () => {
    const { projectId, experimentId, v1Id } = await setup(null);
    expect(await call('PUT', '/999999999/subscription', subscription(projectId))).toMatchObject({
      status: 404,
      body: { error: 'experiment_not_found' },
    });
    expect(await call('PUT', `/${experimentId}/subscription`, subscription(1))).toMatchObject({
      status: 404,
      body: { error: 'experiment_not_found' },
    });
    expect(await call('PUT', `/${v1Id}/subscription`, subscription(projectId))).toMatchObject({
      status: 409,
      body: { error: 'version_mismatch' },
    });
    expect(
      await call(
        'PUT',
        `/${experimentId}/subscription`,
        subscription(projectId, { status: 'archived' }),
      ),
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_status', field: 'status' },
    });
    expect(
      await call(
        'PUT',
        `/${experimentId}/subscription`,
        subscription(projectId, { from: '2025-01-01', to: '2026-10-03' }),
      ),
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_range' },
    });
    expect(
      await call('DELETE', `/${experimentId}/subscription?project_id=${projectId}`),
    ).toMatchObject({
      status: 404,
      body: { error: 'not_subscribed' },
    });

    // Empty experiment (no exposures) → ready with empty rows.
    expect(
      (await call('PUT', `/${experimentId}/subscription`, subscription(projectId))).status,
    ).toBe(200);
    await drain(gated);
    expect(
      (await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`)).body,
    ).toMatchObject({
      status: 'ready',
      rows: [],
    });

    expect(
      await call('DELETE', `/${experimentId}/subscription?project_id=${projectId}`),
    ).toMatchObject({
      status: 200,
      body: { next_run_at: null },
    });
    expect(
      await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`),
    ).toMatchObject({
      status: 404,
      body: { error: 'not_subscribed' },
    });
  });

  it('repeat PUT is idempotent (no new run); a metric change enqueues at high priority', async () => {
    const { projectId, experimentId } = await setup();
    await call('PUT', `/${experimentId}/subscription`, subscription(projectId));
    await drain(gated);
    const keys = modelerKeys(PREFIX);
    await call('PUT', `/${experimentId}/subscription`, subscription(projectId));
    expect(await redis.zscore(keys.queue, `refresh:${projectId}:${experimentId}`)).toBeNull();
    await call(
      'PUT',
      `/${experimentId}/subscription`,
      subscription(projectId, { metrics: ['purchase'] }),
    );
    const score = Number(await redis.zscore(keys.queue, `refresh:${projectId}:${experimentId}`));
    expect(Math.floor(score / 1e13)).toBe(PRIORITY.high);
    await drain(gated);
    const { body } = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(new Set(body.rows.map((r: { metric_key: string }) => r.metric_key))).toEqual(
      new Set(['purchase']),
    );
  });

  it('queries: 202 → dedup → ready rows → cached 200 → refresh 202; 404 / 410 / 400', async () => {
    const { projectId, experimentId } = await setup();
    await call('PUT', `/${experimentId}/subscription`, subscription(projectId));
    const body = {
      view: 'summary',
      project_id: projectId,
      from: '2026-10-01',
      to: '2026-10-03',
      metrics: ['purchase', 'add_payment_info'],
      dimension: 'payment_type',
      refresh: false,
    };

    const accepted = await call('POST', `/${experimentId}/queries`, body);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({
      query_id: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: 'queued',
      retry_after: expect.any(Number),
    });
    const id = accepted.body.query_id as string;
    expect((await call('POST', `/${experimentId}/queries`, body)).body.query_id).toBe(id);

    const pending = await call('GET', `/${experimentId}/queries/${id}?project_id=${projectId}`);
    expect(pending.body).toMatchObject({
      query_id: id,
      view: 'summary',
      status: 'queued',
      rows: [],
      quality: null,
    });

    await drain(gated);
    const ready = await call('GET', `/${experimentId}/queries/${id}?project_id=${projectId}`);
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: 'ready',
      view: 'summary',
      dimension: 'payment_type',
      quality: F1.quality,
    });
    expect(ready.body.computed_at).toEqual(expect.any(String));
    expect(
      ready.body.rows.every(
        (r: { post_exposure?: boolean; dimension: string }) =>
          r.post_exposure === true && r.dimension === 'payment_type',
      ),
    ).toBe(true);

    const cached = await call('POST', `/${experimentId}/queries`, body);
    expect(cached.status).toBe(200);
    expect(cached.body.status).toBe('ready');
    const refreshed = await call('POST', `/${experimentId}/queries`, { ...body, refresh: true });
    expect(refreshed).toMatchObject({ status: 202, body: { query_id: id, status: 'queued' } });

    expect(
      await call('GET', `/${experimentId}/queries/${'0'.repeat(64)}?project_id=${projectId}`),
    ).toMatchObject({
      status: 404,
      body: { error: 'query_not_found' },
    });
    await redis.del(modelerKeys(PREFIX).query(id));
    expect(
      await call('GET', `/${experimentId}/queries/${id}?project_id=${projectId}`),
    ).toMatchObject({
      status: 410,
      body: { error: 'expired' },
    });

    expect(
      await call('POST', `/${experimentId}/queries`, { ...body, dimension: 'ip' }),
    ).toMatchObject({ status: 400, body: { error: 'unknown_dimension' } });
    expect(
      await call('POST', `/${experimentId}/queries`, { ...body, metrics: ['nope'] }),
    ).toMatchObject({ status: 400, body: { error: 'unknown_metric' } });
    expect(
      await call('POST', `/${experimentId}/queries`, { ...body, view: 'heatmap' }),
    ).toMatchObject({ status: 400, body: { error: 'unknown_view' } });
    expect(
      await call('POST', `/${experimentId}/queries`, { ...body, from: '2026-10-09' }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_range' } });
  });

  it('429 too_many_queries: 60 POSTs/min per project and 200 pending', async () => {
    const { projectId, experimentId } = await setup(null);
    await call('PUT', `/${experimentId}/subscription`, subscription(projectId));
    const body = (i: number) => ({
      view: 'summary',
      project_id: projectId,
      from: '2026-10-01',
      to: '2026-10-03',
      metrics: [`event:e${i}`],
    });
    const keys = modelerKeys(PREFIX);

    // Pending limit: pretend 200 are already waiting.
    await redis.zadd(
      keys.queryPending(projectId),
      ...Array.from({ length: 200 }, (_, i) => [i, `fake-${i}`]).flat(),
    );
    expect(await call('POST', `/${experimentId}/queries`, body(0))).toMatchObject({
      status: 429,
      body: { error: 'too_many_queries' },
    });
    await redis.del(keys.queryPending(projectId));

    const statuses: number[] = [];
    for (let i = 1; i <= 61; i++)
      statuses.push((await call('POST', `/${experimentId}/queries`, body(i))).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, 58).every((s) => s === 202)).toBe(true);
  });

  it('p95 under 200 ms for a 14-day × 3-variation × 23-key daily summary', async () => {
    const { projectId, experimentId } = await setup('demo');
    await call(
      'PUT',
      `/${experimentId}/subscription`,
      subscription(projectId, { to: '2026-10-14' }),
    );
    await drain(gated);
    const first = await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
    expect(first.body.rows.length).toBe(14 * 3 * KEYS.length);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await call('GET', `/${experimentId}/daily-summary?project_id=${projectId}`);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    expect(p95).toBeLessThan(200);
  }, 60_000);
});
