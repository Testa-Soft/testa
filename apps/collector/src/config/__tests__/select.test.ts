import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { createConfigStore } from '../select.ts';
import { fakeConfigRedis } from './fake-redis.ts';

const CONFIG = { project_id: 3, config_hash: 'h' } as ProjectConfig;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'testa-config-select-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createConfigStore', () => {
  it('file → writes {projectId}.json under the dir, never touches Redis', async () => {
    const redis = fakeConfigRedis();
    const store = createConfigStore({ kind: 'file', dir, redisPrefix: 'p:' }, () => redis);
    await store.put('a', CONFIG);
    expect(await readdir(dir)).toContain('a.json');
    expect(redis.data.size).toBe(0);
  });

  it('redis → writes under the configured prefix, nothing on disk', async () => {
    const redis = fakeConfigRedis();
    const empty = await mkdtemp(join(tmpdir(), 'testa-config-select-r-'));
    const store = createConfigStore({ kind: 'redis', dir: empty, redisPrefix: 'p:' }, () => redis);
    await store.put('b', CONFIG);
    expect(redis.data.has('p:b')).toBe(true);
    expect(await store.getByProjectId?.(3)).toEqual(CONFIG);
    expect(await readdir(empty)).toEqual([]);
    await rm(empty, { recursive: true, force: true });
  });
});
