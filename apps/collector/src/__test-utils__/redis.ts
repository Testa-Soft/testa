/**
 * Live-Redis test isolation. Every collector test that talks to a real Redis
 * uses ONE test DB (`REDIS_TEST_DB`, default 7) and its own key prefix, and
 * cleans up ONLY its own keys (SCAN by prefix + UNLINK) — never FLUSHDB /
 * FLUSHALL, which would wipe other sessions' live streams (X0 / P5 run their
 * pipelines on the same Redis while the suite runs).
 */
import { randomUUID } from 'node:crypto';
import IORedis, { type Redis } from 'ioredis';

export const REDIS_TEST_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

function parseDb(raw: string | undefined): number {
  const n = Number(raw ?? 7);
  if (!Number.isInteger(n) || n < 0 || n > 15)
    throw new Error(`REDIS_TEST_DB must be 0–15, got "${raw}"`);
  return n;
}

export const REDIS_TEST_DB = parseDb(process.env.REDIS_TEST_DB);

/** `test:<tag>:<random>:` — unique per test file run. */
export function testKeyPrefix(tag: string): string {
  return `test:${tag}:${randomUUID().slice(0, 8)}:`;
}

/** Delete every key starting with `prefix` (SCAN + UNLINK). Returns how many were removed. */
export async function deleteByPrefix(raw: Redis, prefix: string): Promise<number> {
  if (!prefix || prefix === '*')
    throw new Error('deleteByPrefix: refusing an empty / wildcard prefix');
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await raw.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) removed += await raw.unlink(...keys);
  } while (cursor !== '0');
  return removed;
}

/** A raw (unprefixed) client on the test DB, for code that builds its own key prefix. */
export function openRawTestRedis(): Redis {
  return new IORedis(REDIS_TEST_URL, {
    db: REDIS_TEST_DB,
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  });
}

export interface PrefixedTestRedis {
  /** Every key this client touches is transparently prefixed (ioredis `keyPrefix`). */
  client: Redis;
  prefix: string;
  /** Remove this file's keys only. */
  cleanup: () => Promise<number>;
  /** cleanup + quit both connections. */
  close: () => Promise<void>;
}

/**
 * A test-DB client whose keys are all namespaced under a fresh prefix, so code
 * under test (fixed keys like `dedup:…` or the configured stream) stays
 * isolated without changes.
 */
export function openPrefixedTestRedis(tag: string): PrefixedTestRedis {
  const prefix = testKeyPrefix(tag);
  const client = new IORedis(REDIS_TEST_URL, {
    db: REDIS_TEST_DB,
    keyPrefix: prefix,
    lazyConnect: false,
    maxRetriesPerRequest: 1,
  });
  let raw: Redis | null = null;
  const rawClient = (): Redis => {
    raw ??= openRawTestRedis();
    return raw;
  };
  // ioredis `keyPrefix` does not prefix subcommand-style keys (`XGROUP CREATE
  // <key> …` would land unprefixed, outside this file's namespace), so route
  // XGROUP through the raw client with the key prefixed explicitly.
  const xgroup = (sub: string, key: string, ...rest: (string | number)[]) =>
    rawClient().call('XGROUP', sub, `${prefix}${key}`, ...rest);
  Object.assign(client, { xgroup });
  return {
    client,
    prefix,
    cleanup: () => deleteByPrefix(rawClient(), prefix),
    close: async () => {
      await deleteByPrefix(rawClient(), prefix).catch(() => 0);
      await client.quit().catch(() => undefined);
      await raw?.quit().catch(() => undefined);
    },
  };
}
