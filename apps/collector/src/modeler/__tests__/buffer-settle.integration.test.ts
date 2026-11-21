/**
 * Regression: a run must not vouch for events still sitting in an
 * `events_buffer` layer (leadcheck 2026-11-21: run r_01M7ZJD4… counted 4 of 5
 * visitors, was treated as current, and a quiet experiment kept the
 * undercount). Rows go into the real Buffer table and the modeler runs before
 * the flush, against real ClickHouse + Redis.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=modeler_settle \
 *   REDIS_URL=redis://localhost:6380 REDIS_TEST_DB=12 bun test src/modeler
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricKey, ProjectConfig } from '@testa-platform/shared-types';
import IORedis, { type Redis } from 'ioredis';
import { REDIS_TEST_DB, REDIS_TEST_URL, deleteByPrefix } from '../../__test-utils__/redis.ts';
import { fileConfigStore } from '../../config/store.ts';
import { insertRows } from '../../db/clickhouse.ts';
import type { ModelerContext } from '../context.ts';
import { modelerKeys } from '../keys.ts';
import { PRIORITY } from '../queue.ts';
import { readRunState } from '../run-state.ts';
import { requestRefresh, tick } from '../scheduler.ts';
import { chDateTime, writeSubscription } from '../subscriptions.ts';
import { noWebhooks } from '../webhook.ts';
import { drain } from '../worker.ts';
import {
  live,
  prepareDatabase,
  randomExperimentId,
  randomProjectId,
  run,
  seedOracleFx,
  seedSample,
} from './live.ts';

const liveRedis = live && Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const PREFIX = `test:settle:${randomUUID()}:`;
const SETTLE_SEC = 60;
const METRIC: MetricKey = 'purchase';
const created: { projectId: number; experimentId: number }[] = [];
const configDir = mkdtempSync(join(tmpdir(), 'modeler-settle-'));
let redis: Redis;

/** A clock the test moves by hand; the inserted rows use real wall time. */
function makeCtx(clock: { ms: number }): ModelerContext {
  return {
    redis,
    keys: modelerKeys(PREFIX),
    query: run,
    insert: insertRows,
    configStore: fileConfigStore(configDir),
    webhook: noWebhooks,
    settings: {
      concurrency: 1,
      lockTtlSec: 60,
      retryDelaysSec: [],
      queryTtlSec: 3600,
      maxRunAgeSec: 86_400,
      settleSec: SETTLE_SEC,
      pollMs: 50,
    },
    now: () => clock.ms,
    log: () => {},
  };
}

async function experiment(status: 'running' | 'stopped', updatedMs: number) {
  const projectId = randomProjectId();
  const experimentId = randomExperimentId();
  created.push({ projectId, experimentId });
  await seedSample('f1', projectId, experimentId);
  await fileConfigStore(configDir).put(String(projectId), {
    project_id: projectId,
    experiments: [
      {
        experiment_id: experimentId,
        status: 'active',
        platform_version: 'v2',
        variations: [
          { variation_id: 100, weight: 50, changes: [] },
          { variation_id: 101, weight: 50, changes: [] },
        ],
      },
    ],
  } as unknown as ProjectConfig);
  const updatedAt = chDateTime(new Date(updatedMs));
  await writeSubscription(insertRows, {
    projectId,
    experimentId,
    status,
    from: '2026-10-01',
    to: '2026-10-03',
    reportCurrency: 'EUR',
    metrics: [METRIC],
    updatedAt,
  });
  return { projectId, experimentId, updatedAt };
}

/** One event row in the F1 shape (2026-10-03, inside the subscription range). */
function event(
  projectId: number,
  experimentId: number,
  visitorId: string,
  name: 'experiment_view' | 'page_view',
  serverMs: number,
) {
  return {
    event_id: randomUUID(),
    client_ts: '2026-10-03 11:00:00.000',
    server_ts: chDateTime(new Date(serverMs)),
    project_id: projectId,
    visitor_id: visitorId,
    session_id: `s-${visitorId}`,
    event_name: name,
    url: 'https://shop.example/',
    ...(name === 'experiment_view' ? { experiment_id: experimentId, variation_id: 100 } : {}),
    in_experiment: 1,
    exp_ids: [experimentId],
    exp_var_ids: [100],
    exp_session_starts: [1790848800],
  };
}

async function visitors(projectId: number, runId: string): Promise<number> {
  const [row] = await run<{ v: string }>(
    `SELECT sum(visitors) AS v FROM metric_daily
     WHERE project_id = {p:UInt64} AND run_id = {r:String} AND metric_key = {m:String}`,
    { p: projectId, r: runId, m: METRIC },
  );
  return Number(row?.v ?? 0);
}

async function finals(projectId: number, runId: string): Promise<number> {
  const [row] = await run<{ n: string }>(
    `SELECT countIf(is_final = 1) AS n FROM metric_daily
     WHERE project_id = {p:UInt64} AND run_id = {r:String}`,
    { p: projectId, r: runId },
  );
  return Number(row?.n ?? 0);
}

const flushBuffer = () => run('OPTIMIZE TABLE events_buffer', {});

describe.skipIf(!liveRedis)('modeler settle window (live events_buffer + Redis)', () => {
  beforeAll(async () => {
    redis = new IORedis(REDIS_TEST_URL, { db: REDIS_TEST_DB, maxRetriesPerRequest: 1 });
    await prepareDatabase();
    await seedOracleFx('2026-10-01', '2026-10-03');
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
        metrics: [METRIC],
        updatedAt: chDateTime(new Date(Date.now() + 1000)),
      });
    }
    await deleteByPrefix(redis, PREFIX);
    await redis.quit();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('a run that misses a buffered exposure is not current; the re-run after the window counts it', async () => {
    const t0 = Date.now();
    const clock = { ms: t0 + 1000 };
    const ctx = makeCtx(clock);
    const { projectId, experimentId } = await experiment('running', t0 - 3_600_000);
    // Older exposure still in a Buffer layer; a newer event already flushed.
    await insertRows('events_buffer', [
      event(projectId, experimentId, 'late', 'experiment_view', t0 - 5000),
    ]);
    await insertRows('events', [event(projectId, experimentId, 'v1', 'page_view', t0)]);
    const [buffered] = await run<{ n: string }>(
      `SELECT count() AS n FROM exposures WHERE project_id = {p:UInt64} AND visitor_id = 'late'`,
      { p: projectId },
    );
    expect(Number(buffered?.n)).toBe(0);

    expect(await tick(ctx)).toContainEqual({ projectId, experimentId });
    await drain(ctx);
    const first = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(first.status).toBe('ready');
    const missed = await visitors(projectId, first.last_ready_run_id);
    // The watermark stays behind the newest flushed event (t0) …
    expect(first.data_through).toBe(new Date(clock.ms - SETTLE_SEC * 1000).toISOString());
    expect(Date.parse(first.data_through)).toBeLessThan(t0);
    // … so the next tick re-runs it (before the fix: data_through = t0, nothing enqueued).
    expect(await tick(ctx)).toContainEqual({ projectId, experimentId });

    await flushBuffer();
    clock.ms = t0 + (SETTLE_SEC + 2) * 1000;
    await drain(ctx);
    const second = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(second.last_ready_run_id).not.toBe(first.last_ready_run_id);
    expect(await visitors(projectId, second.last_ready_run_id)).toBe(missed + 1);
    expect(second.data_through).toBe(new Date(clock.ms - SETTLE_SEC * 1000).toISOString());
    expect(Date.parse(second.data_through)).toBeGreaterThanOrEqual(t0);
    expect(await tick(ctx)).not.toContainEqual({ projectId, experimentId });
  });

  it('stopped: a run right after the stop is not final; the final run waits for the window', async () => {
    const t0 = Date.now();
    const clock = { ms: t0 + 1000 };
    const ctx = makeCtx(clock);
    const { projectId, experimentId, updatedAt } = await experiment('stopped', t0);
    await insertRows('events_buffer', [
      event(projectId, experimentId, 'late', 'experiment_view', t0 - 2000),
    ]);

    // The subscription PUT runs it at once: a normal run, not the final one.
    await requestRefresh(ctx, projectId, experimentId, PRIORITY.high);
    await drain(ctx);
    const early = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(early.status).toBe('ready');
    expect(early.final_for).toBe('');
    expect(Date.parse(early.data_through)).toBeLessThan(t0);
    expect(await finals(projectId, early.last_ready_run_id)).toBe(0);
    const missed = await visitors(projectId, early.last_ready_run_id);
    expect(await tick(ctx)).not.toContainEqual({ projectId, experimentId });

    await flushBuffer();
    clock.ms = t0 + (SETTLE_SEC + 2) * 1000;
    expect(await tick(ctx)).toContainEqual({ projectId, experimentId });
    await drain(ctx);
    const final = await readRunState(redis, ctx.keys.run(projectId, experimentId));
    expect(final.final_for).toBe(updatedAt);
    // crobot's SyncCandidates treats data_through >= paused_at as "final run landed".
    expect(Date.parse(final.data_through)).toBeGreaterThanOrEqual(t0);
    expect(await finals(projectId, final.last_ready_run_id)).toBeGreaterThan(0);
    expect(await visitors(projectId, final.last_ready_run_id)).toBe(missed + 1);
    expect(await tick(ctx)).not.toContainEqual({ projectId, experimentId });
  });
});
