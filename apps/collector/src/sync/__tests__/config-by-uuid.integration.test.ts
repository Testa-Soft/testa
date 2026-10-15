/**
 * P4-fix1 over real HTTP: crobot publishes the project config by project UUID
 * (`POST /api/v1/config/{uuid}`), while the sync API, subscriptions and events
 * use the numeric project_id. The config route + sync router share one store;
 * subscribe / daily-summary by numeric id must find the UUID-keyed config, and
 * `platform_version` must survive the config build.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p4 \
 *   REDIS_URL=redis://localhost:6380 bun test config-by-uuid
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricKey, SummaryResult } from '@testa-platform/shared-types';
import type { Server } from 'bun';
import { Hono } from 'hono';
import IORedis, { type Redis } from 'ioredis';
import { makeConfigGetHandler, makeConfigPutHandler } from '../../config/route.ts';
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
import { chDateTime, writeSubscription } from '../../modeler/subscriptions.ts';
import { noWebhooks } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import type { SyncContext } from '../context.ts';
import { makeSyncRouter } from '../router.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const SERVICE_TOKEN = 'fix1-service-token-0123456789';
const WRITE_TOKEN = 'fix1-config-write-token';
const PREFIX = `prd006:p4:test-${randomUUID()}:`;
const F1 = readGolden<SummaryResult>('f1', 'daily_summary.json');
const KEYS = [...new Set(F1.rows.map((r) => r.metric_key))] as MetricKey[];

let redis: Redis;
let server: Server;
let base: string;
let ctx: SyncContext;
const configDir = mkdtempSync(join(tmpdir(), 'fix1-config-'));
const projectId = randomProjectId();
const v2Id = randomExperimentId();
const v1Id = randomExperimentId();
const uuid = randomUUID();

/** A crobot ProjectResource-shaped payload (only the fields the build reads). */
function crobotProject() {
  const experiment = (identifier: number, platform_version: string) => ({
    identifier,
    platform_version,
    title: `exp ${identifier}`,
    url: 'https://shop.example/landing',
    url_match_type: 'contains',
    traffic: 100,
    type: 'split_url',
    status: 'active',
    variations: [
      { identifier: 0, traffic: 50, url_match_type: 'contains', changes: [] },
      {
        identifier: 101,
        traffic: 50,
        url_match_type: 'exact',
        changes: [{ url_match_type: 'exact', content: 'https://shop.example/landing-b' }],
      },
    ],
  });
  return {
    id: projectId,
    name: 'Fix1',
    experiments: [experiment(v2Id, 'v2'), experiment(v1Id, 'v1')],
  };
}

async function http(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const sync = (method: string, path: string, body?: unknown) =>
  http(method, `/api/v1/experiments${path}`, { 'X-Service-Token': SERVICE_TOKEN }, body);

describe.skipIf(!liveRedis)(
  'config published by UUID, resolved by numeric project_id (real HTTP)',
  () => {
    beforeAll(async () => {
      redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
        maxRetriesPerRequest: 1,
      });
      const store = fileConfigStore(configDir);
      ctx = {
        redis,
        keys: modelerKeys(PREFIX),
        query: run,
        insert: insertRows,
        configStore: store,
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
      const app = new Hono();
      app.post(
        '/api/v1/config/:projectId',
        makeConfigPutHandler({ store, writeToken: WRITE_TOKEN }),
      );
      app.get('/api/v1/config/:projectId', makeConfigGetHandler({ store }));
      app.route(
        '/api/v1/experiments',
        makeSyncRouter({ serviceToken: SERVICE_TOKEN, context: () => ctx }),
      );
      server = Bun.serve({ port: 0, fetch: app.fetch });
      base = `http://localhost:${server.port}`;

      await prepareDatabase();
      await seedOracleFx('2026-10-01', '2026-10-03');
      await seedSample('f1', projectId, v2Id);
    });

    afterAll(async () => {
      await writeSubscription(insertRows, {
        projectId,
        experimentId: v2Id,
        status: 'deleted',
        from: '2026-10-01',
        to: '2026-10-03',
        reportCurrency: 'EUR',
        metrics: KEYS,
        updatedAt: chDateTime(new Date(Date.now() + 1000)),
      });
      const keys = await redis.keys(`${PREFIX}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
      server.stop(true);
      rmSync(configDir, { recursive: true, force: true });
    });

    it('POST config by UUID → subscribe + daily-summary by numeric id; v1 → 409; UUID GET unchanged', async () => {
      const published = await http(
        'POST',
        `/api/v1/config/${uuid}`,
        { authorization: `Bearer ${WRITE_TOKEN}` },
        crobotProject(),
      );
      expect(published).toMatchObject({
        status: 200,
        body: { ok: true, project_id: projectId, slug: uuid },
      });

      // The UUID-keyed config is served as before, and keeps platform_version.
      const served = await http('GET', `/api/v1/config/${uuid}`, {});
      expect(served.status).toBe(200);
      expect(
        served.body.experiments.map((e: { platform_version?: string }) => e.platform_version),
      ).toEqual(['v2', 'v1']);
      expect((await http('GET', `/api/v1/config/${projectId}`, {})).status).toBe(404);

      const subscription = {
        project_id: projectId,
        status: 'running',
        from: '2026-10-01',
        to: '2026-10-03',
        report_currency: 'EUR',
        metrics: KEYS,
      };
      expect(await sync('PUT', `/${v1Id}/subscription`, subscription)).toMatchObject({
        status: 409,
        body: { error: 'version_mismatch' },
      });
      const put = await sync('PUT', `/${v2Id}/subscription`, subscription);
      expect(put).toMatchObject({ status: 200, body: { status: 'not_ready' } });

      await drain(ctx);
      const summary = await sync('GET', `/${v2Id}/daily-summary?project_id=${projectId}`);
      expect(summary.status).toBe(200);
      expect(summary.body.status).toBe('ready');
      expect(summary.body.rows).toHaveLength(F1.rows.length);
      expect(summary.body.quality).toEqual(F1.quality);

      const query = await sync('POST', `/${v2Id}/queries`, {
        view: 'summary',
        project_id: projectId,
        from: '2026-10-01',
        to: '2026-10-03',
        metrics: ['purchase'],
      });
      expect(query.status).toBe(202);
      await drain(ctx);
      expect(
        (await sync('GET', `/${v2Id}/queries/${query.body.query_id}?project_id=${projectId}`)).body
          .status,
      ).toBe('ready');
    });
  },
);
