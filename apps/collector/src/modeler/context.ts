/**
 * Everything a modeler pass needs, injected so tests can point it at their own
 * ClickHouse database, Redis prefix, config store and webhook sink.
 */
import type { Redis } from 'ioredis';
import type { QueryRunner } from '../analytics/attribution.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ModelerKeys } from './keys.ts';
import type { WebhookSender } from './webhook.ts';

export interface ModelerSettings {
  concurrency: number;
  lockTtlSec: number;
  retryDelaysSec: readonly number[];
  queryTtlSec: number;
  maxRunAgeSec: number;
  pollMs: number;
}

export interface ModelerContext {
  redis: Redis;
  keys: ModelerKeys;
  query: QueryRunner;
  insert: (table: string, rows: readonly object[]) => Promise<void>;
  configStore: ConfigStore;
  webhook: WebhookSender;
  settings: ModelerSettings;
  now: () => number;
  log: (msg: string) => void;
}

/** How long a "query known" marker outlives its result (410 vs 404). */
export const QUERY_KNOWN_TTL_SEC = 7 * 86_400;
