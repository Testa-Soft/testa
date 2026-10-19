/**
 * Admin v2 through the sync API over real HTTP (real ClickHouse + Redis + the
 * real modeler): subscribe with `page:` keys → daily-summary rows carry
 * `count_sq_visitor`; RE2-invalid regex → 400 `invalid_regex` on the
 * subscription PUT and the query POST; summed rows → `POST /api/v1/stats`
 * with `model: 'count'` (the request crobot sends for `count_mode: every`).
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=admin_v2_collector \
 *   REDIS_URL=redis://localhost:6380 bun test page-keys-sync
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DailyRow, ProjectConfig, VariationStats } from '@testa-platform/shared-types';
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
  run,
} from '../../modeler/__tests__/live.ts';
import {
  EXPECTED,
  FROM,
  PAGE_KEYS,
  SEED_KEYS,
  TO,
  seedPageEvents,
} from '../../modeler/__tests__/page-seed.ts';
import { modelerKeys } from '../../modeler/keys.ts';
import { chDateTime, writeSubscription } from '../../modeler/subscriptions.ts';
import { noWebhooks } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import { makeStatsRouter } from '../../stats/router.ts';
import type { SyncContext } from '../context.ts';
import { makeSyncRouter } from '../router.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const TOKEN = 'admin-v2-sync-token-0123456789';
const PREFIX = `admin-v2:page-keys:${randomUUID()}:`;
const BAD_REGEX = `page:regex:${encodeURIComponent('/thanks(?=\\?)')}`;

let redis: Redis;
let server: Server;
let base: string;
let ctx: SyncContext;
const configDir = mkdtempSync(join(tmpdir(), 'admin-v2-config-'));
const projectId = randomProjectId();
const experimentId = randomExperimentId();

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'X-Service-Token': TOKEN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const subscription = (metrics: string[]) => ({
  project_id: projectId,
  status: 'stopped',
  from: FROM,
  to: TO,
  report_currency: 'EUR',
  metrics,
});

describe.skipIf(!liveRedis)('admin v2 page keys via sync API (live CH + Redis, HTTP)', () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, { db: REDIS_TEST_DB, maxRetriesPerRequest: 1 });
    ctx = {
      redis,
      keys: modelerKeys(PREFIX),
      query: run,
      insert: insertRows,
      configStore: fileConfigStore(configDir),
      webhook: noWebhooks,
      settings: {
        concurrency: 1,
        lockTtlSec: 60,
        retryDelaysSec: [0],
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
    app.route('/api/v1/stats', makeStatsRouter({ serviceToken: TOKEN }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${server.port}`;
    await prepareDatabase();
    await seedPageEvents(projectId, experimentId);
    await fileConfigStore(configDir).put(String(projectId), {
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
    } as unknown as ProjectConfig);
  });

  afterAll(async () => {
    await writeSubscription(insertRows, {
      projectId,
      experimentId,
      status: 'deleted',
      from: FROM,
      to: TO,
      reportCurrency: 'EUR',
      metrics: SEED_KEYS,
      updatedAt: chDateTime(new Date(Date.now() + 1000)),
    });
    await deleteByPrefix(redis, PREFIX);
    await redis.quit();
    server.stop(true);
    rmSync(configDir, { recursive: true, force: true });
  });

  it('PUT subscription with an RE2-invalid page regex → 400 invalid_regex', async () => {
    const res = await call(
      'PUT',
      `/api/v1/experiments/${experimentId}/subscription`,
      subscription([...SEED_KEYS, BAD_REGEX]),
    );
    expect(res).toEqual({ status: 400, body: { error: 'invalid_regex', field: BAD_REGEX } });
  });

  it('POST summary query with an RE2-invalid page regex → 400 invalid_regex', async () => {
    const res = await call('POST', `/api/v1/experiments/${experimentId}/queries`, {
      project_id: projectId,
      view: 'summary',
      from: FROM,
      to: TO,
      report_currency: 'EUR',
      metrics: [BAD_REGEX],
    });
    expect(res).toEqual({ status: 400, body: { error: 'invalid_regex', field: BAD_REGEX } });
  });

  it('subscribe → modeler run → daily-summary rows with page keys + count_sq_visitor → count stats', async () => {
    const put = await call(
      'PUT',
      `/api/v1/experiments/${experimentId}/subscription`,
      subscription(SEED_KEYS),
    );
    expect(put.status).toBe(200);
    await drain(ctx);

    const summary = await call(
      'GET',
      `/api/v1/experiments/${experimentId}/daily-summary?project_id=${projectId}`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body.status).toBe('ready');
    const rows = summary.body.rows as DailyRow[];
    expect(rows).toHaveLength(2 * SEED_KEYS.length);
    for (const r of rows) {
      expect([r.converted, r.count, r.count_sq_visitor]).toEqual(
        EXPECTED[r.variation_id]?.[r.metric_key] ?? [-1, -1, -1],
      );
    }

    // What crobot sends for a `count_mode: every` page goal: n = visitors,
    // sum = Σ count, sumSq = Σ count_sq_visitor, summed over the range.
    const variations = [100, 101].map((v) => {
      const mine = rows.filter((r) => r.variation_id === v && r.metric_key === PAGE_KEYS.contains);
      return {
        variation: v,
        n: mine.reduce((a, r) => a + r.visitors, 0),
        sum: mine.reduce((a, r) => a + r.count, 0),
        sumSq: mine.reduce((a, r) => a + r.count_sq_visitor, 0),
      };
    });
    expect(variations).toEqual([
      { variation: 100, n: 3, sum: 2, sumSq: 4 },
      { variation: 101, n: 3, sum: 4, sumSq: 10 },
    ]);
    const stats = await call('POST', '/api/v1/stats', {
      control: 100,
      metrics: [{ key: PAGE_KEYS.contains, model: 'count', variations }],
    });
    expect(stats.status).toBe(200);
    const metrics = stats.body.metrics as Record<string, Record<string, VariationStats>>;
    const v101 = metrics[PAGE_KEYS.contains]?.['101'];
    // 3 visitors per arm: flagged insufficient; direction still follows the means (2/3 vs 4/3).
    expect(v101?.insufficient_data).toBe(true);
    expect(v101?.chance_to_beat_control).toBeGreaterThan(0.5);
  });
});
