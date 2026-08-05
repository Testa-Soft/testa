import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import IORedis, { type Redis } from 'ioredis';
import { enqueue } from '../../ingest/stream.ts';
import { Consumer } from '../consumer.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
const url = process.env.REDIS_URL ?? 'redis://localhost:6380';
const TEST_DB = 9;

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
  if (liveRedis) await getClient().flushdb();
});

const STREAM = 'test:events';
const GROUP = 'test:group';

function makeEvent(overrides: Partial<EnrichedEvent> = {}): EnrichedEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    event_name: 'page_view',
    client_ts: 1730902400000,
    project_id: 1,
    visitor_id: 'v1',
    session_id: 's1',
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

describe.skipIf(!liveRedis)('Consumer (live Redis, mocked CH)', () => {
  it('reads, inserts, and ACKs a batch', async () => {
    const redis = getClient();
    const inserted: object[][] = [];
    const consumer = new Consumer({
      redis,
      insertEvents: async (rows) => {
        inserted.push([...rows]);
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });

    await consumer.ensureGroup();
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });

    const tick = await consumer.tick();
    expect(tick).toEqual({ flushed: 2, failed: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);

    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0);
  });

  it('does not ACK on insert failure (entries stay in PEL)', async () => {
    const redis = getClient();
    const consumer = new Consumer({
      redis,
      insertEvents: async () => {
        throw new Error('CH down');
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await enqueue(makeEvent(), {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });

    const tick = await consumer.tick();
    expect(tick.failed).toBe(true);
    expect(tick.flushed).toBe(0);

    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(1);
  });

  it("drops unparseable entries (ACKs them so we don't loop)", async () => {
    const redis = getClient();
    const consumer = new Consumer({
      redis,
      insertEvents: async () => undefined,
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 100,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await redis.xadd(STREAM, '*', 'ev', 'not-json{');
    const tick = await consumer.tick();
    expect(tick.flushed).toBe(0);
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0);
  });
});

/**
 * Drives the long-running `start()` loop (not `tick()`), which owns the
 * happy-path drain, the poison-retry drop, backoff, and clean `stop()`.
 */
describe.skipIf(!liveRedis)('Consumer.start / stop loop (live Redis, mocked CH)', () => {
  async function enq(redis: Redis, ev: EnrichedEvent): Promise<void> {
    await enqueue(ev, {
      redis,
      streamKey: STREAM,
      streamMaxLen: 1000,
      dedupNames: ['purchase'],
      dedupTtlSec: 60,
    });
  }

  async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor timed out');
  }

  it('drains enqueued events end-to-end, then stops cleanly', async () => {
    const redis = getClient();
    const inserted: object[] = [];
    const consumer = new Consumer({
      redis,
      insertEvents: async (rows) => {
        inserted.push(...rows);
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 20,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await enq(redis, makeEvent());
    await enq(redis, makeEvent());
    await enq(redis, makeEvent());

    const loop = consumer.start();
    await waitFor(() => inserted.length === 3);
    await consumer.stop();
    await loop;

    expect(inserted).toHaveLength(3);
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0); // all ACKed
  });

  it('drops a poison batch after poisonRetries and ACKs it', async () => {
    const redis = getClient();
    let attempts = 0;
    const consumer = new Consumer({
      redis,
      insertEvents: async () => {
        attempts += 1;
        throw new Error('CH permanently rejects this batch');
      },
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 20,
      backoffStartMs: 1,
      backoffMaxMs: 4,
      poisonRetries: 3,
      log: () => undefined,
    });
    await consumer.ensureGroup();
    await enq(redis, makeEvent());

    const loop = consumer.start();
    // Flush is retried until poisonRetries is hit; the failing batch is then ACKed (dropped).
    await waitFor(() => attempts >= 3);
    await consumer.stop();
    await loop;

    expect(attempts).toBeGreaterThanOrEqual(3); // failed poisonRetries times before dropping
    const pending = await redis.xpending(STREAM, GROUP);
    expect((pending as [number])[0]).toBe(0); // poison entry was dropped (ACKed)
  });

  it('stop() is a no-op when the loop was never started', async () => {
    const redis = getClient();
    const consumer = new Consumer({
      redis,
      insertEvents: async () => undefined,
      streamKey: STREAM,
      consumerGroup: GROUP,
      consumerName: 'c1',
      batchSize: 10,
      blockMs: 20,
      log: () => undefined,
    });
    await expect(consumer.stop()).resolves.toBeUndefined();
  });
});
