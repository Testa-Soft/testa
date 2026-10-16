import { afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ProjectConfig } from '@testa-platform/shared-types';
import IORedis from 'ioredis';
import { REDIS_TEST_URL, deleteByPrefix } from '../../__test-utils__/redis.ts';
import { DEFAULT_CONFIG_KEY_PREFIX, redisConfigStore } from '../redis-store.ts';
import type { ConfigStore } from '../store.ts';
import { fakeConfigRedis } from './fake-redis.ts';

const CONFIG: ProjectConfig = {
  project_id: 2,
  slug: '12345',
  integration_version: '4.0',
  consent_mode: 'aware',
  experiments: [],
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'abc',
};
const UUID = '9b2f6c1e-4d1a-4f7e-9c3b-2a1d5e8f0a11';

/** The same contract the file store satisfies (store.test.ts), for any backing Redis. */
function contract(name: string, makeStore: () => ConfigStore): void {
  describe(name, () => {
    it('round-trips a config by store key; absent → null', async () => {
      const store = makeStore();
      await store.put('12345', CONFIG);
      expect(await store.get('12345')).toEqual(CONFIG);
      expect(await store.get('does-not-exist')).toBeNull();
    });

    it('rejects unsafe projectIds', async () => {
      const store = makeStore();
      await expect(store.put('../evil', CONFIG)).rejects.toThrow();
      await expect(store.get('a:b')).rejects.toThrow();
    });

    it('indexes a UUID-keyed config by its numeric project_id', async () => {
      const store = makeStore();
      const config = { ...CONFIG, project_id: 4242, slug: UUID };
      await store.put(UUID, config);
      expect(await store.getByProjectId?.(4242)).toEqual(config);
      expect(await store.get('4242')).toBeNull();
    });

    it('falls back to a config stored under the numeric id; unknown / invalid ids → null', async () => {
      const store = makeStore();
      await store.put('7', { ...CONFIG, project_id: 7 });
      expect((await store.getByProjectId?.(7))?.project_id).toBe(7);
      expect(await store.getByProjectId?.(987654)).toBeNull();
      expect(await store.getByProjectId?.(-1)).toBeNull();
      expect(await store.getByProjectId?.(1.5)).toBeNull();
    });

    it('ignores a stale alias whose target now belongs to another project', async () => {
      const store = makeStore();
      await store.put('shared-key', { ...CONFIG, project_id: 11 });
      await store.put('shared-key', { ...CONFIG, project_id: 12 });
      expect(await store.getByProjectId?.(11)).toBeNull();
      expect((await store.getByProjectId?.(12))?.project_id).toBe(12);
    });
  });
}

contract('redisConfigStore (in-memory Redis)', () => redisConfigStore(fakeConfigRedis()));

describe('redisConfigStore keys', () => {
  it('namespaces the config and the numeric alias under the prefix', async () => {
    const redis = fakeConfigRedis();
    await redisConfigStore(redis).put(UUID, { ...CONFIG, project_id: 4242 });
    expect(DEFAULT_CONFIG_KEY_PREFIX).toBe('testa:config:');
    expect(JSON.parse(redis.data.get(`testa:config:${UUID}`) ?? 'null').project_id).toBe(4242);
    expect(redis.data.get('testa:config:by-project-id:4242')).toBe(UUID);
  });

  it('writes no alias for a non-positive project_id', async () => {
    const redis = fakeConfigRedis();
    await redisConfigStore(redis).put('k', { ...CONFIG, project_id: 0 });
    expect([...redis.data.keys()]).toEqual(['testa:config:k']);
  });

  it('treats a corrupt stored value as absent', async () => {
    const redis = fakeConfigRedis();
    await redis.mset('testa:config:bad', '{not json');
    expect(await redisConfigStore(redis).get('bad')).toBeNull();
  });

  it('propagates Redis errors (the GET route answers 503, not 404)', async () => {
    const failing = {
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
      mset: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const store = redisConfigStore(failing);
    await expect(store.get('x')).rejects.toThrow('ECONNREFUSED');
    await expect(store.put('x', CONFIG)).rejects.toThrow('ECONNREFUSED');
  });
});

// Live Redis: DB 14 (collector suites flush 7–11; other harnesses use 12/13),
// own key prefix, cleaned by prefix only — never FLUSHDB.
const LIVE_DB = 14;
const liveRedis = Boolean(process.env.REDIS_URL ?? process.env.RUN_LIVE_REDIS);
const livePrefix = `test:config-store:${randomUUID().slice(0, 8)}:`;
const live = liveRedis
  ? new IORedis(REDIS_TEST_URL, { db: LIVE_DB, maxRetriesPerRequest: 1 })
  : null;

describe.skipIf(!live)(`redisConfigStore (live Redis DB ${LIVE_DB})`, () => {
  afterAll(async () => {
    await deleteByPrefix(live as IORedis, livePrefix);
    await live?.quit();
  });
  contract('contract', () => redisConfigStore(live as IORedis, { prefix: livePrefix }));
});
