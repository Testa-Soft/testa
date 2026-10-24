/**
 * `view: health` live (task 5.17, 006-validation V14): reference samples in
 * real ClickHouse, the query through the real sync HTTP route
 * (`POST …/queries` → modeler drain → `GET …/queries/:id`), asserted against
 * `docs/reference/samples/{f1,demo}/modeled/health.json`.
 *
 * Known golden deviation (reported to the orchestrator, goldens untouched):
 * health counts raw attributed events, duplicates included (006-validation F1
 * "control 2 (v1 incl. duplicate)"; generate.py health(): "duplicates
 * included"). The oracle's code counts the purchase-deduped list instead, so
 * its goldens are short by the reload duplicates: F1 control purchase 1 → 2,
 * and demo purchase events by the duplicates of exposed visitors.
 *
 * The view is NOT imported here: it must be registered by the modeler's
 * query-job path (`modeler/query-jobs.ts`), as in a deployed modeler.
 *
 * Run: CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p8 \
 *      REDIS_URL=redis://localhost:6380 bun test src/health
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthEvent, HealthResult, ProjectConfig } from '@testa-platform/shared-types';
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
  seedSample,
} from '../../modeler/__tests__/live.ts';
import { modelerKeys } from '../../modeler/keys.ts';
import { noWebhooks } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import type { SyncContext } from '../../sync/context.ts';
import { makeSyncRouter } from '../../sync/router.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const TOKEN = 'health-test-token-0123456789';
const PREFIX = `prd006:p8:test-${randomUUID()}:`;
const configDir = mkdtempSync(join(tmpdir(), 'health-config-'));

let redis: Redis;
let server: Server;
let base: string;
let ctx: SyncContext;

function makeContext(): SyncContext {
  return {
    redis,
    keys: modelerKeys(PREFIX),
    query: run,
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

async function setup(sample: 'f1' | 'demo', variationIds: number[]) {
  const projectId = randomProjectId();
  const experimentId = randomExperimentId();
  await seedSample(sample, projectId, experimentId);
  const config = {
    project_id: projectId,
    experiments: [
      {
        experiment_id: experimentId,
        status: 'active',
        platform_version: 'v2',
        rules: [],
        goals: [],
        traffic_allocation: 100,
        variations: variationIds.map((id) => ({ variation_id: id, weight: 1, changes: [] })),
      },
    ],
  } as unknown as ProjectConfig;
  await fileConfigStore(configDir).put(String(projectId), config);
  return { projectId, experimentId };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/v1/experiments${path}`, {
    method,
    headers: { 'X-Service-Token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** POST the health query, run the modeler queue, GET the stored result. */
async function healthQuery(projectId: number, experimentId: number, from: string, to: string) {
  const body = { view: 'health', project_id: projectId, from, to, report_currency: 'EUR' };
  const accepted = await call('POST', `/${experimentId}/queries`, body);
  expect(accepted.status).toBe(202);
  await drain(ctx);
  const ready = await call(
    'GET',
    `/${experimentId}/queries/${String(accepted.body.query_id)}?project_id=${projectId}`,
  );
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ status: 'ready', view: 'health' });
  return ready.body.result as HealthResult;
}

const eventOf = (r: HealthResult, name: string): HealthEvent => {
  const e = r.events.find((x) => x.event_name === name);
  if (!e) throw new Error(`no ${name} in health result`);
  return e;
};

describe.skipIf(!liveRedis)('health view (live ClickHouse + Redis, real HTTP)', () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, {
      db: REDIS_TEST_DB,
      maxRetriesPerRequest: 1,
    });
    ctx = makeContext();
    const app = new Hono();
    app.route('/api/v1/experiments', makeSyncRouter({ serviceToken: TOKEN, context: () => ctx }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${server.port}`;
    await prepareDatabase();
  });

  afterAll(async () => {
    await deleteByPrefix(redis, PREFIX);
    await redis.quit();
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  it('F1 matches health.json (purchase control counts v1’s reload duplicate: 2)', async () => {
    const { projectId, experimentId } = await setup('f1', [100, 101]);
    const result = await healthQuery(projectId, experimentId, '2026-10-01', '2026-10-03');
    const golden = readGolden<HealthResult>('f1', 'health.json');
    const purchase = eventOf(golden, 'purchase');
    const expected: HealthResult = {
      ...golden,
      experiment_id: experimentId,
      events: golden.events.map((e) =>
        e === purchase ? { ...e, events: { ...e.events, '100': 2 } } : e,
      ),
    };
    expect(result).toEqual(expected);

    // The validation-doc expectations, spelled out.
    expect(eventOf(result, 'purchase').events).toEqual({ '100': 2, '101': 3 });
    const atc = eventOf(result, 'add_to_cart');
    expect(atc.status).toBe('warning');
    expect(atc.params.find((p) => p.param === 'items[].price')?.present_pct).toBe(0.5);
    expect(
      eventOf(result, 'add_payment_info').params.find((p) => p.param === 'payment_type')
        ?.present_pct,
    ).toBe(1);
    expect(result.summary.param_warnings).toBeGreaterThanOrEqual(1);
    expect(result.metrics.find((m) => m.key === 'buy_to_cart')).toEqual({
      key: 'buy_to_cart',
      availability: 'limited',
      reason: 'add_to_cart: warning',
    });
  });

  it('demo matches health.json except purchase, which adds reload duplicates', async () => {
    const { projectId, experimentId } = await setup('demo', [100, 101, 102]);
    const result = await healthQuery(projectId, experimentId, '2026-10-01', '2026-10-14');
    const golden = readGolden<HealthResult>('demo', 'health.json');

    for (const g of golden.events.filter((e) => e.event_name !== 'purchase')) {
      expect(eventOf(result, g.event_name)).toEqual(g);
    }
    const got = eventOf(result, 'purchase');
    const want = eventOf(golden, 'purchase');
    expect(got.status).toBe(want.status);
    expect(got.visitors).toEqual(want.visitors);
    const extra = Object.keys(want.events).map((v) => (got.events[v] ?? 0) - (want.events[v] ?? 0));
    expect(extra.every((d) => d >= 0)).toBe(true);
    // 12 orders are reloaded in the raw demo set; only exposed visitors' count.
    const total = extra.reduce((s, d) => s + d, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(12);

    expect(result.metrics).toEqual(golden.metrics);
    expect(result.summary).toEqual(golden.summary);
    expect(result.srm.ok).toBe(golden.srm.ok);
    expect(result.srm.chi2).toBeCloseTo(golden.srm.chi2, 3);
    expect(result.srm.p_value).toBeCloseTo(golden.srm.p_value, 3);
    for (const [v, w] of Object.entries(golden.srm.expected_weights)) {
      expect(result.srm.expected_weights[v]).toBeCloseTo(w, 4);
    }
  });

  it('a range with no exposures: every event missing, metrics unavailable, SRM neutral', async () => {
    const { projectId, experimentId } = await setup('f1', [100, 101]);
    const result = await healthQuery(projectId, experimentId, '2026-11-01', '2026-11-02');
    expect(result.events.every((e) => e.status === 'missing')).toBe(true);
    expect(result.events.every((e) => e.params.every((p) => p.present_pct === null))).toBe(true);
    expect(result.metrics.every((m) => m.availability === 'unavailable')).toBe(true);
    expect(result.srm).toMatchObject({ chi2: 0, p_value: 1, ok: true });
    expect(result.summary).toMatchObject({ events_receiving: 0, events_expected: 7 });
  });

  it('400s through the route: bad range, filters', async () => {
    const { projectId, experimentId } = await setup('f1', [100, 101]);
    const body = { view: 'health', project_id: projectId, report_currency: 'EUR' };
    expect(
      await call('POST', `/${experimentId}/queries`, {
        ...body,
        from: '2026-10-03',
        to: '2026-10-01',
      }),
    ).toEqual({ status: 400, body: { error: 'invalid_range', field: 'from' } });
    expect(
      await call('POST', `/${experimentId}/queries`, {
        ...body,
        from: '2026-10-01',
        to: '2026-10-03',
        filters: { country: ['LT'] },
      }),
    ).toEqual({ status: 400, body: { error: 'unknown_dimension', field: 'filters' } });
  });
});
