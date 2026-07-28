/**
 * Phase 1 end-to-end integration test.
 *
 * Requires: live Redis (REDIS_URL env) + ClickHouse (CLICKHOUSE_URL env).
 * In CI, both are provided via services in the test-collector job.
 * Tests skip when REDIS_URL is absent (local dev without docker).
 *
 * Flow: POST /_ingest → Redis stream → Consumer (XREADGROUP) → CH INSERT →
 *       poll events_buffer (Buffer reads from both buffer + base table).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import IORedis from 'ioredis';
import { config } from '../config.ts';
import { Consumer } from '../consumer/consumer.ts';
import { insertEvents, query } from '../db/clickhouse.ts';
import server from '../index.ts';
import { __setRedisForTests } from '../redis/client.ts';

const liveStack = process.env.REDIS_URL;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
// Dedicated DB so we don't step on route.test.ts (DB 10) or consumer.test.ts (DB 9).
const TEST_DB = 8;
// Unique per PID so parallel CI matrix runs don't collide.
const TEST_PID = 1_000_000 + (process.pid % 1_000);

function makeEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: crypto.randomUUID(),
    event_name: 'page_view',
    client_ts: Date.now() - 500,
    project_id: TEST_PID,
    visitor_id: 'v-int',
    session_id: 's-int',
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 1280,
    viewport_h: 720,
    server_ts: Date.now(),
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
    ...overrides,
  };
}

async function postBatch(
  events: EnrichedEvent[],
  opts: { signedAt?: number; tamper?: boolean } = {},
): Promise<Response> {
  const body = JSON.stringify({ signed_at: opts.signedAt ?? Date.now(), events });
  const sigSrc = opts.tamper ? `${body} ` : body;
  const sig = createHmac('sha256', config.ingest.sharedSecret).update(sigSrc).digest('hex');
  return server.fetch(
    new Request('http://test.local/_ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-signature': sig },
      body,
    }),
  );
}

async function countInCh(projectId: number): Promise<number> {
  const [row] = await query<{ c: string }>(
    'SELECT count() AS c FROM events_buffer WHERE project_id = {pid:UInt64}',
    { pid: projectId },
  );
  return Number(row?.c ?? 0);
}

describe.skipIf(!liveStack)('Phase 1 integration (live Redis + ClickHouse)', () => {
  let consumer: Consumer;
  let consumerDone: Promise<void>;
  let testRedis: IORedis;

  beforeAll(async () => {
    testRedis = new IORedis(REDIS_URL, {
      db: TEST_DB,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    await testRedis.flushdb();
    // Point the server's redis singleton at our test DB.
    __setRedisForTests(testRedis);

    // Fresh consumer group name per run avoids BUSYGROUP clashes on retries.
    consumer = new Consumer({
      redis: testRedis,
      insertEvents,
      streamKey: config.redis.streamKey,
      consumerGroup: `integration-${Date.now()}`,
      consumerName: 'it-worker',
      batchSize: 100,
      blockMs: 100,
    });
    consumerDone = consumer.start();
  });

  afterAll(async () => {
    await consumer.stop();
    await consumerDone.catch(() => undefined);
    await testRedis.flushdb().catch(() => undefined);
    await testRedis.quit().catch(() => undefined);
    __setRedisForTests(null);
  });

  it('50 signed events land in ClickHouse within 15 s', async () => {
    const events = Array.from({ length: 50 }, () => makeEvent());
    const res = await postBatch(events);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('50');

    const deadline = Date.now() + 15_000;
    let got = 0;
    while (Date.now() < deadline) {
      got = await countInCh(TEST_PID);
      if (got === 50) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(got).toBe(50);
  }, 20_000);

  it('rejects a tampered body (signature mismatch) with 401', async () => {
    const res = await postBatch([makeEvent()], { tamper: true });
    expect(res.status).toBe(401);
  });

  it('rejects a stale signed_at (replay window exceeded) with 401', async () => {
    const staleAt = Date.now() - (config.ingest.replayWindowSec * 1000 + 5_000);
    const res = await postBatch([makeEvent()], { signedAt: staleAt });
    expect(res.status).toBe(401);
  });

  it('rejects a batch with a missing required field with 400', async () => {
    const body = JSON.stringify({ signed_at: Date.now(), events: [{ wrong: 'shape' }] });
    const sig = createHmac('sha256', config.ingest.sharedSecret).update(body).digest('hex');
    const res = await server.fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-signature': sig },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });
});
