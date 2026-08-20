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
});
