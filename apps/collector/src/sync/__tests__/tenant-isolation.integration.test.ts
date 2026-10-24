/**
 * R3 (CROBOT-REQUESTS): crobot experiment identifiers are unique per project
 * only, so two projects can both have experiment 1717. Over real HTTP against
 * real ClickHouse + Redis and the real modeler (`runOnce`), everything keyed
 * by experiment must stay isolated per `(project_id, experiment_id)`:
 * subscriptions, run state, metric_daily reads, query jobs and webhooks.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p4fix3 \
 *   REDIS_URL=redis://localhost:6380 bun test src/sync/__tests__/tenant-isolation
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  MetricKey,
  ProjectConfig,
  SummaryResult,
  WebhookPayload,
} from '@testa-platform/shared-types';
import type { Server } from 'bun';
import { Hono } from 'hono';
import IORedis, { type Redis } from 'ioredis';
import { REDIS_TEST_DB, REDIS_TEST_URL, deleteByPrefix } from '../../__test-utils__/redis.ts';
import { fileConfigStore } from '../../config/store.ts';
import { insertRows } from '../../db/clickhouse.ts';
import {
  live,
  prepareDatabase,
  randomProjectId,
  readGolden,
  run,
  seedOracleFx,
  seedSample,
} from '../../modeler/__tests__/live.ts';
import { modelerKeys } from '../../modeler/keys.ts';
import { runOnce } from '../../modeler/main.ts';
import { readRunState } from '../../modeler/run-state.ts';
import { chDateTime, writeSubscription } from '../../modeler/subscriptions.ts';
import { createWebhookSender } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import type { SyncContext } from '../context.ts';
import { makeSyncRouter } from '../router.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const TOKEN = 'tenant-test-token-0123456789';
const PREFIX = `prd006:p4fix3:test-${randomUUID()}:`;
const SECRET = 'tenant-webhook-secret-0123456789';
const F1 = readGolden<SummaryResult>('f1', 'daily_summary.json');
const KEYS = [...new Set(F1.rows.map((r) => r.metric_key))] as MetricKey[];
/** The colliding identifier: both projects call their experiment 1717. */
const EXP = 1717;

let redis: Redis;
let api: Server;
let hookServer: Server;
let base: string;
let ctx: SyncContext;
const hooks: WebhookPayload[] = [];
const configDir = mkdtempSync(join(tmpdir(), 'tenant-config-'));
// Project A: F1 data, every golden key, EUR. Project B: F1 data, purchase only, USD.
const A = randomProjectId();
const B = A + 1;

function projectConfig(projectId: number): ProjectConfig {
  return {
    project_id: projectId,
    experiments: [
      {
        experiment_id: EXP,
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

const headers = { 'X-Service-Token': TOKEN, 'content-type': 'application/json' };

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1/experiments${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
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

const summary = (projectId: number) => call('GET', `/${EXP}/daily-summary?project_id=${projectId}`);

const metricKeysOf = (rows: { metric_key: string }[]) => new Set(rows.map((r) => r.metric_key));

describe.skipIf(!liveRedis)('R3 tenant isolation: same experiment id in two projects', () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, {
      db: REDIS_TEST_DB,
      maxRetriesPerRequest: 1,
    });
    hookServer = Bun.serve({
      port: 0,
      async fetch(req) {
        hooks.push((await req.json()) as WebhookPayload);
        return new Response('ok');
      },
    });
    ctx = {
      redis,
      keys: modelerKeys(PREFIX),
      query: run,
      insert: insertRows,
      configStore: fileConfigStore(configDir),
      webhook: createWebhookSender({
        url: `http://localhost:${hookServer.port}`,
        secret: SECRET,
        retryDelaysSec: [0.05],
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
      intervalSec: 900,
    };
    const app = new Hono();
    app.route('/api/v1/experiments', makeSyncRouter({ serviceToken: TOKEN, context: () => ctx }));
    api = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${api.port}`;

    await prepareDatabase();
    await seedOracleFx('2026-10-01', '2026-10-03');
    await seedSample('f1', A, EXP);
    await seedSample('f1', B, EXP);
    await fileConfigStore(configDir).put(String(A), projectConfig(A));
    await fileConfigStore(configDir).put(String(B), projectConfig(B));
  });

  afterAll(async () => {
    for (const projectId of [A, B]) {
      await writeSubscription(insertRows, {
        projectId,
        experimentId: EXP,
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
    api.stop(true);
    hookServer.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  it('every experiment-scoped route requires project_id (400 invalid_body)', async () => {
    const want = { status: 400, body: { error: 'invalid_body', field: 'project_id' } };
    const { project_id: _p, ...noProject } = subscription(A);
    expect(await call('PUT', `/${EXP}/subscription`, noProject)).toEqual(want);
    expect(await call('PUT', `/${EXP}/subscription`, subscription(A, { project_id: 'x' }))).toEqual(
      want,
    );
    expect(await call('DELETE', `/${EXP}/subscription`)).toEqual(want);
    expect(await call('DELETE', `/${EXP}/subscription?project_id=0`)).toEqual(want);
    expect(await call('GET', `/${EXP}/daily-summary`)).toEqual(want);
    expect(await call('GET', `/${EXP}/daily-summary?project_id=abc`)).toEqual(want);
    expect(
      await call('POST', `/${EXP}/queries`, {
        view: 'summary',
        from: '2026-10-01',
        to: '2026-10-03',
        metrics: ['purchase'],
      }),
    ).toEqual(want);
    expect(await call('GET', `/${EXP}/queries/${'a'.repeat(64)}`)).toEqual(want);
  });

  it('a project that does not own the experiment → 404 experiment_not_found', async () => {
    const stranger = B + 1;
    const want = { status: 404, body: { error: 'experiment_not_found' } };
    expect(await call('PUT', `/${EXP}/subscription`, subscription(stranger))).toEqual(want);
    expect(await call('DELETE', `/${EXP}/subscription?project_id=${stranger}`)).toEqual(want);
    expect(await call('GET', `/${EXP}/daily-summary?project_id=${stranger}`)).toEqual(want);
    expect(
      await call('POST', `/${EXP}/queries`, {
        view: 'summary',
        project_id: stranger,
        from: '2026-10-01',
        to: '2026-10-03',
        metrics: ['purchase'],
      }),
    ).toEqual(want);
    expect(await call('GET', `/${EXP}/queries/${'a'.repeat(64)}?project_id=${stranger}`)).toEqual(
      want,
    );
  });

  it('subscribe both → one modeler pass → each daily summary returns only its own rows; run state + webhooks per project', async () => {
    expect((await call('PUT', `/${EXP}/subscription`, subscription(A))).status).toBe(200);
    expect(
      (
        await call(
          'PUT',
          `/${EXP}/subscription`,
          subscription(B, { metrics: ['purchase'], report_currency: 'USD' }),
        )
      ).status,
    ).toBe(200);

    // Both PUTs queued their own refresh job (the job and run-state keys carry the project).
    const queued = await redis.zrange(ctx.keys.queue, 0, -1);
    expect(queued).toContain(`refresh:${A}:${EXP}`);
    expect(queued).toContain(`refresh:${B}:${EXP}`);
    const once = await runOnce(ctx);
    expect(once.processed).toBeGreaterThanOrEqual(2);
    expect(once.failed).toEqual([]);

    const a = await summary(A);
    const b = await summary(B);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toMatchObject({ status: 'ready', experiment_id: EXP, report_currency: 'EUR' });
    expect(b.body).toMatchObject({ status: 'ready', experiment_id: EXP, report_currency: 'USD' });
    expect(a.body.run_id).not.toBe(b.body.run_id);
    expect(a.body.rows.length).toBe(F1.rows.length);
    expect(metricKeysOf(a.body.rows)).toEqual(new Set(KEYS));
    expect(metricKeysOf(b.body.rows)).toEqual(new Set(['purchase']));
    expect(b.body.rows.length).toBe(F1.rows.filter((r) => r.metric_key === 'purchase').length);

    const stateA = await readRunState(redis, ctx.keys.run(A, EXP));
    const stateB = await readRunState(redis, ctx.keys.run(B, EXP));
    expect(stateA.last_ready_run_id).toBe(a.body.run_id);
    expect(stateB.last_ready_run_id).toBe(b.body.run_id);
    expect(stateA.report_currency).toBe('EUR');
    expect(stateB.report_currency).toBe('USD');

    await ctx.webhook.drain();
    const ready = hooks.filter(
      (h): h is Extract<WebhookPayload, { event: 'summary-ready' }> =>
        h.event === 'summary-ready' && h.experiment_id === EXP,
    );
    expect(ready.find((h) => h.run_id === a.body.run_id)?.project_id).toBe(A);
    expect(ready.find((h) => h.run_id === b.body.run_id)?.project_id).toBe(B);
  });

  it('query jobs are isolated: separate ids, a foreign project cannot read them, query-ready carries project_id', async () => {
    const body = (projectId: number) => ({
      view: 'summary',
      project_id: projectId,
      from: '2026-10-01',
      to: '2026-10-03',
      metrics: ['purchase'],
    });
    const qa = await call('POST', `/${EXP}/queries`, body(A));
    const qb = await call('POST', `/${EXP}/queries`, body(B));
    expect(qa.status).toBe(202);
    expect(qb.status).toBe(202);
    const idA = qa.body.query_id as string;
    const idB = qb.body.query_id as string;
    expect(idA).not.toBe(idB);

    expect(await call('GET', `/${EXP}/queries/${idA}?project_id=${B}`)).toMatchObject({
      status: 404,
      body: { error: 'query_not_found' },
    });
    await drain(ctx);
    await ctx.webhook.drain();

    const ra = await call('GET', `/${EXP}/queries/${idA}?project_id=${A}`);
    const rb = await call('GET', `/${EXP}/queries/${idB}?project_id=${B}`);
    expect(ra.body).toMatchObject({ status: 'ready', query_id: idA });
    expect(rb.body).toMatchObject({ status: 'ready', query_id: idB });

    const queryHooks = hooks.filter(
      (h): h is Extract<WebhookPayload, { event: 'query-ready' }> => h.event === 'query-ready',
    );
    expect(queryHooks.find((h) => h.query_id === idA)?.project_id).toBe(A);
    expect(queryHooks.find((h) => h.query_id === idB)?.project_id).toBe(B);
  });

  it("deleting one project's subscription leaves the other's untouched", async () => {
    const before = await summary(B);
    expect(await call('DELETE', `/${EXP}/subscription?project_id=${A}`)).toMatchObject({
      status: 200,
      body: { next_run_at: null },
    });
    expect(await summary(A)).toMatchObject({ status: 404, body: { error: 'not_subscribed' } });
    const after = await summary(B);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({ status: 'ready', run_id: before.body.run_id });
    expect(after.body.rows.length).toBe(before.body.rows.length);
    // A's later pass schedules nothing for A (deleted) and leaves B's run alone.
    const once = await runOnce(ctx);
    expect(once.enqueued).not.toContainEqual({ projectId: A, experimentId: EXP });
    expect((await summary(B)).body.run_id).toBe(before.body.run_id);
  });
});
