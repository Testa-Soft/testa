/**
 * Redis-backed config store — shared by every collector process (API, sync API,
 * modeler) and every machine, unlike `fileConfigStore`, whose directory is a
 * per-machine volume (staging bug: the modeler had no configs, and configs were
 * lost with the API machine's volume).
 *
 * Keys (prefix default `testa:config:`):
 *   {prefix}{storeKey}                → the same ProjectConfig JSON the file store writes
 *   {prefix}by-project-id:{numericId} → the store key (crobot publishes by project UUID)
 * Store keys are validated to `[A-Za-z0-9_-]`, so they never collide with the
 * `by-project-id:` alias namespace. Redis errors propagate (the GET route maps
 * them to 503, not 404).
 */

import type { ProjectConfig } from '@testa-platform/shared-types';
import { type ConfigStore, assertSafeProjectId, isSafeProjectId } from './store.ts';

export const DEFAULT_CONFIG_KEY_PREFIX = 'testa:config:';

/** The two Redis commands the store needs (ioredis `Redis` satisfies it). */
export interface ConfigRedis {
  get(key: string): Promise<string | null>;
  mset(...keysAndValues: string[]): Promise<unknown>;
}

export interface RedisConfigStoreOptions {
  prefix?: string;
}

const isPositiveId = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

function parseConfig(raw: string | null): ProjectConfig | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ProjectConfig;
  } catch {
    return null; // corrupt value → treated as absent, like an unreadable file
  }
}

export function redisConfigStore(
  redis: ConfigRedis,
  options: RedisConfigStoreOptions = {},
): ConfigStore {
  const prefix = options.prefix ?? DEFAULT_CONFIG_KEY_PREFIX;
  const configKey = (projectId: string): string => {
    assertSafeProjectId(projectId);
    return `${prefix}${projectId}`;
  };
  const aliasKey = (numericId: number): string => `${prefix}by-project-id:${numericId}`;

  const get = async (projectId: string): Promise<ProjectConfig | null> =>
    parseConfig(await redis.get(configKey(projectId)));

  return {
    async put(projectId, config) {
      const json = `${JSON.stringify(config, null, 2)}\n`;
      const alias = isPositiveId(config.project_id) ? [aliasKey(config.project_id), projectId] : [];
      // One MSET: config and alias land atomically.
      await redis.mset(configKey(projectId), json, ...alias);
    },

    get,

    async getByProjectId(projectId) {
      if (!isPositiveId(projectId)) return null;
      const key = await redis.get(aliasKey(projectId));
      if (key !== null && isSafeProjectId(key)) {
        const config = await get(key);
        if (config?.project_id === projectId) return config;
      }
      return get(String(projectId));
    },
  };
}
