import { expect } from 'bun:test';
/**
 * Live harness for the P7 query views: reference samples in real ClickHouse,
 * a project config in a temp file store, and the real sync HTTP route
 * (`POST …/queries` → modeler drain → `GET …/queries/:id`). Views are NOT
 * imported here: the modeler query-job path must register them.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@testa-platform/shared-types';
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
  seedOracleFx,
  seedSample,
} from '../../modeler/__tests__/live.ts';
import { modelerKeys } from '../../modeler/keys.ts';
import { noWebhooks } from '../../modeler/webhook.ts';
import { drain } from '../../modeler/worker.ts';
import type { SyncContext } from '../../sync/context.ts';
import { makeSyncRouter } from '../../sync/router.ts';

export const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);

const TOKEN = 'p7-test-token-0123456789';

export interface QueryHarness {
  setup(
    sample: 'f1' | 'demo',
    variationIds: number[],
  ): Promise<{ projectId: number; experimentId: number }>;
  call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** POST a query, drain the modeler queue, return the stored result. */
  result<T>(experimentId: number, body: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function openHarness(name: string): Promise<QueryHarness> {
  const prefix = `prd006:p7:${name}-${randomUUID()}:`;
  const configDir = mkdtempSync(join(tmpdir(), `${name}-config-`));
  const redis: Redis = new IORedis(REDIS_TEST_URL, {
    db: REDIS_TEST_DB,
    maxRetriesPerRequest: 1,
  });
  const ctx: SyncContext = {
    redis,
    keys: modelerKeys(prefix),
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
  const app = new Hono();
  app.route('/api/v1/experiments', makeSyncRouter({ serviceToken: TOKEN, context: () => ctx }));
  const server: Server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}/api/v1/experiments`;
  await prepareDatabase();
  await seedOracleFx('2026-10-01', '2026-10-15');

  const call: QueryHarness['call'] = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'X-Service-Token': TOKEN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  return {
    async setup(sample, variationIds) {
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
    },
    call,
    async result<T>(experimentId: number, body: Record<string, unknown>): Promise<T> {
      const accepted = await call('POST', `/${experimentId}/queries`, body);
      expect(accepted.status).toBe(202);
      await drain(ctx);
      const ready = await call(
        'GET',
        `/${experimentId}/queries/${String(accepted.body.query_id)}?project_id=${String(body.project_id)}`,
      );
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({ status: 'ready', view: body.view });
      return ready.body.result as T;
    },
    async close() {
      await deleteByPrefix(redis, prefix);
      await redis.quit();
      server.stop(true);
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}
