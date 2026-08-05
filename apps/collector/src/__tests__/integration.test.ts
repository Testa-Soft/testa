/**
 * Phase 1 end-to-end integration test (task 1.7).
 *
 * Proves the write path closes without the edge worker: we sign a batch
 * ourselves, POST it to the real `/_ingest` handler, drive the real Consumer
 * to drain Redis → ClickHouse, then assert the rows land in CH with the right
 * shape. The three primary auth/validation failure modes are checked too.
 *
 * Requires live infra (`docker-compose up redis clickhouse`); skipped otherwise,
 * matching the `skipIf(!liveRedis)` convention used across the collector suite.
 * Run with: `REDIS_URL=redis://localhost:6380 CLICKHOUSE_URL=http://localhost:8123 bun test`.
 *
 * Isolation:
 *   - Redis: a dedicated test DB, flushed before each test.
 *   - ClickHouse: every event in a run shares a unique `session_id` marker, so
 *     counts/asserts only ever see this run's rows (no per-test CH teardown).
 *   - CH reads hit the `events_buffer` Buffer table directly, which returns
 *     in-memory rows immediately — no waiting on the 5–30s Buffer flush.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EnrichedEvent, IngestBatch } from '@testa-platform/shared-types';
import { Hono } from 'hono';
import IORedis, { type Redis } from 'ioredis';
import { config } from '../config.ts';
import { Consumer } from '../consumer/consumer.ts';
import { insertEvents, query } from '../db/clickhouse.ts';
import { sign } from '../ingest/hmac.ts';
import { makeIngestHandler } from '../ingest/route.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;
const live = liveRedis && liveCh;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_DB = 11;

let client: Redis | null = null;
function getClient(): Redis {
  if (!client) {
    client = new IORedis(url, { db: TEST_DB, lazyConnect: false, maxRetriesPerRequest: 1 });
  }
  return client;
}

afterAll(async () => {
  if (client) {
    await client.flushdb().catch(() => undefined);
    await client.quit().catch(() => undefined);
    client = null;
  }
});

beforeEach(async () => {
  if (live) await getClient().flushdb();
});

function buildApp(): Hono {
  const app = new Hono();
  app.post('/_ingest', makeIngestHandler({ getRedis: () => getClient() }));
  return app;
}

/** Event with a real UUID (CH `event_id` is UUID — `evt-…` strings won't parse). */
function makeEvent(marker: string, overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: randomUUID(),
    event_name: 'page_view',
    client_ts: 1730902400000,
    project_id: 1,
    visitor_id: 'v1',
    session_id: marker,
    url: 'https://example.com/',
    consent_state: 'granted',
    tracker_version: '4.0.0',
    viewport_w: 0,
    viewport_h: 0,
    server_ts: 1730902400500,
    country: 'US',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: '',
    os: '',
    is_bot: 0,
    ...overrides,
  };
}

async function postBatch(
  app: Hono,
  events: EnrichedEvent[],
  opts: { tamper?: boolean; signedAt?: number } = {},
): Promise<Response> {
  const batch: IngestBatch = { signed_at: opts.signedAt ?? Date.now(), events };
  const body = JSON.stringify(batch);
  const signature = sign(opts.tamper ? `${body} ` : body, config.ingest.sharedSecret);
  return app.fetch(
    new Request('http://test.local/_ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-edge-signature': signature },
      body,
    }),
  );
}

/**
 * A Consumer wired to the real CH insert, reading the same stream the route
 * writes. The group is created up front (at `$`) so it must exist *before* the
 * batch is enqueued — otherwise XREADGROUP `>` skips the pre-existing entries.
 */
async function buildConsumer(): Promise<Consumer> {
  const consumer = new Consumer({
    redis: getClient(),
    insertEvents,
    streamKey: config.redis.streamKey,
    consumerGroup: `it-group-${randomUUID().slice(0, 8)}`,
    consumerName: 'it-consumer',
    batchSize: 100,
    blockMs: 50,
    log: () => undefined,
  });
  await consumer.ensureGroup();
  return consumer;
}

/** Drain the stream into CH, one tick at a time, until `expected` rows flush. */
async function drainToCh(consumer: Consumer, expected: number): Promise<number> {
  let flushed = 0;
  for (let i = 0; i < 20 && flushed < expected; i++) {
    const r = await consumer.tick();
    flushed += r.flushed;
  }
  return flushed;
}

async function countBySession(marker: string): Promise<number> {
  const rows = await query<{ n: string }>(
    'SELECT count() AS n FROM events_buffer WHERE session_id = {marker:String}',
    { marker },
  );
  return Number(rows[0]?.n ?? 0);
}

describe.skipIf(!live)('Phase 1 ingest → consumer → ClickHouse (live)', () => {
  it('lands a signed batch of 50 events in ClickHouse with the right shape', async () => {
    const marker = `it-run-${randomUUID()}`;
    const events = Array.from({ length: 50 }, () => makeEvent(marker));
    const consumer = await buildConsumer(); // group must exist before we enqueue

    const res = await postBatch(buildApp(), events);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('50');

    const flushed = await drainToCh(consumer, 50);
    expect(flushed).toBe(50);
    expect(await countBySession(marker)).toBe(50);

    // NB: CH serializes 64-bit ints as JSON strings (precision-safe), so
    // project_id comes back as "1" — coerce before comparing.
    const sample = await query<{ event_name: string; project_id: string; consent_state: string }>(
      `SELECT event_name, project_id, consent_state
       FROM events_buffer WHERE session_id = {marker:String} LIMIT 1`,
      { marker },
    );
    expect(sample[0]?.event_name).toBe('page_view');
    expect(sample[0]?.consent_state).toBe('granted');
    expect(Number(sample[0]?.project_id)).toBe(1);
  });

  it('rejects a tampered body (401) and writes nothing', async () => {
    const marker = `it-tamper-${randomUUID()}`;
    const consumer = await buildConsumer();
    const res = await postBatch(buildApp(), [makeEvent(marker)], { tamper: true });
    expect(res.status).toBe(401);
    await drainToCh(consumer, 1);
    expect(await countBySession(marker)).toBe(0);
  });

  it('rejects a stale signed_at outside the replay window (401)', async () => {
    const marker = `it-stale-${randomUUID()}`;
    const tooOld = Date.now() - (config.ingest.replayWindowSec * 1000 + 5_000);
    const res = await postBatch(buildApp(), [makeEvent(marker)], { signedAt: tooOld });
    expect(res.status).toBe(401);
    expect(await countBySession(marker)).toBe(0);
  });

  it('rejects a schema-invalid batch (400)', async () => {
    const body = JSON.stringify({ signed_at: Date.now(), events: [{ wrong: 'shape' }] });
    const signature = sign(body, config.ingest.sharedSecret);
    const res = await buildApp().fetch(
      new Request('http://test.local/_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-signature': signature },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });
});
