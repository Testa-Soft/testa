import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import type { Redis } from 'ioredis';
import { openPrefixedTestRedis } from '../../__test-utils__/redis.ts';
import { enqueue } from '../stream.ts';

const liveRedis = process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS;
// One shared test DB (REDIS_TEST_DB) + a key prefix unique to this file run;
// cleanup deletes only this file's keys (never FLUSHDB — other sessions share Redis).
const redisTest = liveRedis ? openPrefixedTestRedis('stream') : null;

function getClient(): Redis {
  if (!redisTest) throw new Error('live Redis disabled (set REDIS_URL)');
  return redisTest.client;
}

afterAll(async () => {
  await redisTest?.close();
});

beforeEach(async () => {
  await redisTest?.cleanup();
});

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
    viewport_w: 1024,
    viewport_h: 768,
    screen_w: 1920,
    screen_h: 1080,
    exp: [],
    server_ts: 1730902400500,
    country: 'US',
    region: 'CA',
    region_subdivision: '',
    city: 'San Francisco',
    device_type: 'desktop',
    browser: 'chrome',
    os: 'macos',
    os_name: 'macos',
    os_version: '',
    browser_name: 'chrome',
    browser_version: '',
    referrer_domain: '(direct)',
    channel: 'Direct',
    is_bot: 0,
    ...overrides,
  };
}

const STREAM = 'test:events';
const DEPS = (redis: Redis) => ({
  redis,
  streamKey: STREAM,
  streamMaxLen: 10_000,
  dedupNames: ['purchase'],
  dedupTtlSec: 60,
});

describe('enqueue (live Redis)', () => {
  it.skipIf(!liveRedis)('writes a non-dedup event to the stream', async () => {
    const redis = getClient();
    const r = await enqueue(makeEvent(), DEPS(redis));
    expect(r.written).toBe(true);
    expect(r.deduped).toBe(false);
    expect(r.streamId).toMatch(/^\d+-\d+$/);
    const len = await redis.xlen(STREAM);
    expect(len).toBe(1);
  });

  it.skipIf(!liveRedis)('dedups a purchase fired twice with the same event_id', async () => {
    const redis = getClient();
    const ev = makeEvent({ event_name: 'purchase', event_id: 'order-42' });
    const a = await enqueue(ev, DEPS(redis));
    const b = await enqueue(ev, DEPS(redis));
    expect(a.written).toBe(true);
    expect(b.written).toBe(false);
    expect(b.deduped).toBe(true);
    expect(await redis.xlen(STREAM)).toBe(1);
  });

  it.skipIf(!liveRedis)('non-dedup event names are never gated even on repeat ids', async () => {
    const redis = getClient();
    const ev = makeEvent({ event_name: 'page_view', event_id: 'pv-replay' });
    await enqueue(ev, DEPS(redis));
    await enqueue(ev, DEPS(redis));
    expect(await redis.xlen(STREAM)).toBe(2);
  });

  it.skipIf(!liveRedis)('stored payload round-trips as JSON', async () => {
    const redis = getClient();
    const ev = makeEvent({ url: 'https://example.com/page?x=1' });
    await enqueue(ev, DEPS(redis));
    const entries = await redis.xrange(STREAM, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] ?? [];
    const idx = fields.indexOf('ev');
    expect(idx).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(fields[idx + 1] as string);
    expect(parsed).toEqual(ev);
  });
});
