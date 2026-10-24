/**
 * Live-Redis test isolation proof: a test file's cleanup removes only its own
 * prefixed keys — a sentinel in ANOTHER DB and one in the SAME DB under another
 * prefix survive (no FLUSHDB). Runs when REDIS_URL is set.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import {
  REDIS_TEST_DB,
  REDIS_TEST_URL,
  deleteByPrefix,
  openPrefixedTestRedis,
  openRawTestRedis,
} from '../redis.ts';

const liveRedis = Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const OTHER_DB = (REDIS_TEST_DB + 1) % 16;
const run = randomUUID().slice(0, 8);
const sameDbSentinel = `test:sentinel-other-file:${run}:keep`;
const otherDbSentinel = `test:sentinel-other-db:${run}:keep`;

describe.skipIf(!liveRedis)(`live Redis test isolation (test DB ${REDIS_TEST_DB})`, () => {
  const raw = liveRedis ? openRawTestRedis() : null;
  const other = liveRedis
    ? new IORedis(REDIS_TEST_URL, { db: OTHER_DB, maxRetriesPerRequest: 1 })
    : null;

  afterAll(async () => {
    // Remove exactly the sentinels this test created.
    await raw?.del(sameDbSentinel);
    await other?.del(otherDbSentinel);
    await raw?.quit();
    await other?.quit();
  });

  it("a file's cleanup deletes only its own keys; other prefixes and other DBs survive", async () => {
    if (!raw || !other) throw new Error('unreachable');
    await raw.set(sameDbSentinel, 'same-db');
    await other.set(otherDbSentinel, 'other-db');

    const file = openPrefixedTestRedis('isolation-proof');
    // Keys written through the prefixed client, incl. a stream + group (XGROUP).
    await file.client.set('dedup:purchase:e1', '1');
    await file.client.xadd('events', '*', 'ev', '{}');
    await file.client.xgroup('CREATE', 'events', 'g1', '0', 'MKSTREAM');
    const before = await raw.keys(`${file.prefix}*`);
    expect(before.sort()).toEqual([`${file.prefix}dedup:purchase:e1`, `${file.prefix}events`]);
    // Nothing leaked outside the prefix (XGROUP included).
    expect(await raw.exists('events', 'dedup:purchase:e1')).toBe(0);

    expect(await file.cleanup()).toBe(2);
    expect(await raw.keys(`${file.prefix}*`)).toEqual([]);
    expect(await raw.get(sameDbSentinel)).toBe('same-db');
    expect(await other.get(otherDbSentinel)).toBe('other-db');
    await file.close();
  });

  it('deleteByPrefix refuses an empty or wildcard prefix', async () => {
    if (!raw) throw new Error('unreachable');
    await expect(deleteByPrefix(raw, '')).rejects.toThrow();
    await expect(deleteByPrefix(raw, '*')).rejects.toThrow();
  });
});
