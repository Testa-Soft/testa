/**
 * One-time file → Redis config migration, run on API startup with
 * `CONFIG_STORE=redis`: every `{key}.json` in CONFIG_DIR that the target store
 * does not have yet is copied in (with its numeric alias, via `put`). Existing
 * target entries are never overwritten, so it is idempotent and a newer publish
 * always wins over the volume copy.
 */

import { readdir } from 'node:fs/promises';
import { type ConfigStore, fileConfigStore } from './store.ts';

const CONFIG_FILE = /^([A-Za-z0-9_-]+)\.json$/;

export interface MigrateOptions {
  dir: string;
  target: Pick<ConfigStore, 'get' | 'put'>;
  log: (message: string) => void;
}

export interface MigrateResult {
  copied: readonly string[];
  skipped: readonly string[];
  failed: readonly string[];
}

async function listConfigKeys(dir: string): Promise<readonly string[]> {
  try {
    const names = await readdir(dir);
    return names.flatMap((name) => CONFIG_FILE.exec(name)?.slice(1, 2) ?? []);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

type Outcome = 'copied' | 'skipped' | 'failed';

async function migrateOne(
  key: string,
  source: ConfigStore,
  { target, log }: MigrateOptions,
): Promise<Outcome> {
  try {
    if ((await target.get(key)) !== null) return 'skipped';
    const config = await source.get(key);
    if (!config) return 'skipped'; // unreadable / corrupt file — nothing to copy
    await target.put(key, config);
    log(`migrated config ${key} (project_id ${config.project_id}) from file to redis`);
    return 'copied';
  } catch (err) {
    log(`failed to migrate config ${key}: ${(err as Error).message}`);
    return 'failed';
  }
}

export async function migrateFileConfigs(options: MigrateOptions): Promise<MigrateResult> {
  const source = fileConfigStore(options.dir);
  const keys = await listConfigKeys(options.dir);
  const outcomes = await Promise.all(keys.map((key) => migrateOne(key, source, options)));
  const pick = (o: Outcome): readonly string[] => keys.filter((_, i) => outcomes[i] === o);
  return { copied: pick('copied'), skipped: pick('skipped'), failed: pick('failed') };
}
