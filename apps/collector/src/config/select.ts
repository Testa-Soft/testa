/**
 * Pick the config store from config (`CONFIG_STORE=file|redis`). Every process
 * that reads or writes configs (API config route, sync API, modeler) builds its
 * store here, so they all agree on where configs live.
 */

import { type ConfigRedis, redisConfigStore } from './redis-store.ts';
import { type ConfigStore, fileConfigStore } from './store.ts';

export type ConfigStoreKind = 'file' | 'redis';

export interface ConfigStoreSettings {
  kind: ConfigStoreKind;
  /** File store directory; also the one-time migration source for `redis`. */
  dir: string;
  redisPrefix: string;
}

export function createConfigStore(
  settings: ConfigStoreSettings,
  getRedis: () => ConfigRedis,
): ConfigStore {
  return settings.kind === 'redis'
    ? redisConfigStore(getRedis(), { prefix: settings.redisPrefix })
    : fileConfigStore(settings.dir);
}
