import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@testa-platform/shared-types';
import { assertSafeProjectId, configFilename, fileConfigStore } from '../store.ts';

const CONFIG: ProjectConfig = {
  project_id: 2,
  slug: '12345',
  integration_version: '4.0',
  consent_mode: 'aware',
  experiments: [],
  published_at: '2026-08-04T00:00:00.000Z',
  config_hash: 'abc',
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'testa-config-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fileConfigStore', () => {
  it('writes a static {projectId}.json file and reads it back', async () => {
    const store = fileConfigStore(dir);
    await store.put('12345', CONFIG);

    // The file exists on disk, pretty-printed.
    const onDisk = await readFile(join(dir, configFilename('12345')), 'utf8');
    expect(JSON.parse(onDisk)).toEqual(CONFIG);

    const got = await store.get('12345');
    expect(got).toEqual(CONFIG);
  });

  it('returns null for an absent project', async () => {
    const store = fileConfigStore(dir);
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('rejects unsafe projectIds (path traversal)', async () => {
    const store = fileConfigStore(dir);
    await expect(store.put('../evil', CONFIG)).rejects.toThrow();
    expect(() => assertSafeProjectId('a/b')).toThrow();
    expect(() => assertSafeProjectId('..')).toThrow();
    expect(() => assertSafeProjectId('ok-123_ABC')).not.toThrow();
  });

  it('indexes a UUID-keyed config by its numeric project_id (UUID behaviour unchanged)', async () => {
    const store = fileConfigStore(dir);
    const uuid = '9b2f6c1e-4d1a-4f7e-9c3b-2a1d5e8f0a11';
    const config = { ...CONFIG, project_id: 4242, slug: uuid };
    await store.put(uuid, config);

    expect(await store.get(uuid)).toEqual(config);
    expect(await store.getByProjectId?.(4242)).toEqual(config);
    // No config file appears under the numeric key: GET /api/v1/config/4242 still 404s.
    expect(await store.get('4242')).toBeNull();
  });

  it('falls back to a config stored under the numeric id; unknown ids → null', async () => {
    const store = fileConfigStore(dir);
    await store.put('7', { ...CONFIG, project_id: 7 });
    expect((await store.getByProjectId?.(7))?.project_id).toBe(7);
    expect(await store.getByProjectId?.(987654)).toBeNull();
    expect(await store.getByProjectId?.(-1)).toBeNull();
  });

  it('ignores a stale alias whose target now belongs to another project', async () => {
    const store = fileConfigStore(dir);
    await store.put('shared-key', { ...CONFIG, project_id: 11 });
    await store.put('shared-key', { ...CONFIG, project_id: 12 });
    expect(await store.getByProjectId?.(11)).toBeNull();
    expect((await store.getByProjectId?.(12))?.project_id).toBe(12);
  });
});
