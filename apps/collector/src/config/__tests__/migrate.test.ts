import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { migrateFileConfigs } from '../migrate.ts';
import { redisConfigStore } from '../redis-store.ts';
import { fileConfigStore } from '../store.ts';
import { fakeConfigRedis } from './fake-redis.ts';

const config = (projectId: number, hash: string): ProjectConfig =>
  ({ project_id: projectId, config_hash: hash }) as ProjectConfig;
const UUID = '9b2f6c1e-4d1a-4f7e-9c3b-2a1d5e8f0a11';
const silent = (): void => undefined;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'testa-config-migrate-'));
  const files = fileConfigStore(dir);
  await files.put(UUID, config(4242, 'from-file'));
  await files.put('already', config(5, 'from-file'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migrateFileConfigs', () => {
  it('copies configs missing from the target (with the numeric alias), keeps existing ones', async () => {
    const target = redisConfigStore(fakeConfigRedis());
    await target.put('already', config(5, 'from-redis'));
    const logs: string[] = [];

    const result = await migrateFileConfigs({ dir, target, log: (m) => logs.push(m) });

    expect(result).toEqual({ copied: [UUID], skipped: ['already'], failed: [] });
    expect((await target.getByProjectId?.(4242))?.config_hash).toBe('from-file');
    expect((await target.get('already'))?.config_hash).toBe('from-redis');
    expect(logs.some((m) => m.includes(UUID))).toBe(true);
  });

  it('is idempotent: a second run copies nothing', async () => {
    const target = redisConfigStore(fakeConfigRedis());
    await migrateFileConfigs({ dir, target, log: silent });
    const again = await migrateFileConfigs({ dir, target, log: silent });
    expect(again.copied).toEqual([]);
    expect([...again.skipped].sort()).toEqual(['already', UUID].sort());
  });

  it('a missing dir is a no-op', async () => {
    const target = redisConfigStore(fakeConfigRedis());
    const result = await migrateFileConfigs({ dir: join(dir, 'nope'), target, log: silent });
    expect(result).toEqual({ copied: [], skipped: [], failed: [] });
  });

  it('records per-config failures and keeps going', async () => {
    const failing = {
      get: async () => null,
      put: async () => {
        throw new Error('down');
      },
    };
    const result = await migrateFileConfigs({ dir, target: failing, log: silent });
    expect(result.copied).toEqual([]);
    expect([...result.failed].sort()).toEqual(['already', UUID].sort());
  });
});
