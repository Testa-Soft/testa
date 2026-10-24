import { z } from 'zod';

const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),

  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().default('default'),

  // Default host port 6380 matches docker-compose.yml mapping (avoids clashes
  // with other local Redis instances). Override via REDIS_URL when needed.
  REDIS_URL: z.string().default('redis://localhost:6380'),
  REDIS_STREAM_KEY: z.string().default('events'),
  REDIS_CONSUMER_GROUP: z.string().default('collector-writers'),
  REDIS_CONSUMER_NAME: z.string().default(`collector-${process.pid}`),
  /** Approximate cap on stream length (XADD MAXLEN ~ N). 0 disables. */
  REDIS_STREAM_MAXLEN: z.coerce.number().int().nonnegative().default(1_000_000),

  INGEST_SHARED_SECRET: z.string().min(16).default('dev-secret-change-me-please-1234'),
  /** Window (seconds) for HMAC replay protection. */
  INGEST_REPLAY_WINDOW: z.coerce.number().int().positive().default(300),

  SERVICE_TOKEN: z.string().min(16).default('dev-service-token-change-me-1234'),

  FX_API_URL: z.string().url().default('https://api.frankfurter.app'),

  CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().default(1000),
  CONSUMER_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  /** Comma-separated event names that should be deduplicated. */
  DEDUP_EVENT_NAMES: z.string().default('purchase'),
  /** Dedup TTL for the Redis SET NX EX gate. */
  DEDUP_TTL_SEC: z.coerce.number().int().positive().default(600),

  /**
   * Directory the config API writes servable `{projectId}.json` files to — the
   * local stand-in for the object bucket / CDN origin we push configs (and later
   * events) to. Served statically from here.
   */
  CONFIG_DIR: z.string().default('.data/configs'),
  /**
   * Where configs live. `redis` (REDIS_URL) is shared by every process and
   * machine — required when the modeler / sync API run apart from the API
   * (staging). `file` (CONFIG_DIR) is the default so config-only deployments
   * without Redis (production `testa-collector`) and local dev keep working.
   * With `redis`, the API copies CONFIG_DIR files missing from Redis on startup.
   */
  CONFIG_STORE: z.enum(['file', 'redis']).default('file'),
  /** Redis key prefix for configs (`{prefix}{key}`, `{prefix}by-project-id:{n}`). */
  CONFIG_REDIS_PREFIX: z.string().min(1).default('testa:config:'),

  /**
   * Shared secret required on `POST /api/v1/config/*` (the config WRITE path).
   * crobot sends it as `Authorization: Bearer <token>`. GET stays public.
   */
  CONFIG_WRITE_TOKEN: z.string().min(8).default('dev-config-token-change-me-please'),

  // ── PRD-006 modeler (task 5.15) ──────────────────────────────────────────
  /** Prefix for every modeler Redis key (queue, locks, run state, query results). */
  MODELER_KEY_PREFIX: z.string().default(''),
  /** Parallel runs per modeler instance. */
  MODELER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Scheduler tick (seconds). */
  MODELER_INTERVAL_SEC: z.coerce.number().int().positive().default(900),
  /** Force a refresh when the last finished run is older than this (seconds). */
  MODELER_MAX_RUN_AGE_SEC: z.coerce.number().int().positive().default(86_400),
  /** Per-experiment lock TTL (seconds). */
  MODELER_LOCK_TTL_SEC: z.coerce.number().int().positive().default(600),
  /** ClickHouse `max_execution_time` per modeler query (seconds). */
  MODELER_MAX_EXECUTION_SEC: z.coerce.number().int().positive().default(300),
  /** Backoff between failed attempts (seconds, comma-separated); attempts = length + 1. */
  MODELER_RETRY_DELAYS_SEC: z.string().default('30,120,300'),
  /** How long an on-demand query result is kept (seconds). */
  MODELER_QUERY_TTL_SEC: z.coerce.number().int().positive().default(3600),
  /** Worker idle poll interval (ms). */
  MODELER_POLL_MS: z.coerce.number().int().positive().default(1000),
  /** `1` = one synchronous pass (schedule, drain the queue, exit). Same as `--once`. */
  MODELER_ONCE: z.enum(['0', '1']).default('0'),
  /** Crobot base URL for the optional webhooks; empty disables them. */
  CROBOT_WEBHOOK_URL: z.string().default(''),
  /** HMAC-SHA256 secret for `X-Testa-Signature`. Required when the URL is set. */
  CROBOT_WEBHOOK_SECRET: z.string().default(''),
  /** Webhook retry backoff (seconds, comma-separated). */
  CROBOT_WEBHOOK_RETRY_DELAYS_SEC: z.string().default('10,60,300'),
});

const parsed = envSchema.parse(process.env);

/** `"30,120,300"` → `[30, 120, 300]`; fails fast on anything else. */
function parseDelays(raw: string, name: string): readonly number[] {
  const delays = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (delays.some((d) => !Number.isFinite(d) || d < 0)) {
    throw new Error(`${name} must be comma-separated non-negative seconds, got "${raw}"`);
  }
  return delays;
}

export const config = {
  environment: parsed.ENVIRONMENT,
  port: parsed.PORT,
  version: '0.0.0',

  clickhouse: {
    url: parsed.CLICKHOUSE_URL,
    user: parsed.CLICKHOUSE_USER,
    password: parsed.CLICKHOUSE_PASSWORD,
    database: parsed.CLICKHOUSE_DATABASE,
  },

  redis: {
    url: parsed.REDIS_URL,
    streamKey: parsed.REDIS_STREAM_KEY,
    streamMaxLen: parsed.REDIS_STREAM_MAXLEN,
    consumerGroup: parsed.REDIS_CONSUMER_GROUP,
    consumerName: parsed.REDIS_CONSUMER_NAME,
  },

  ingest: {
    sharedSecret: parsed.INGEST_SHARED_SECRET,
    replayWindowSec: parsed.INGEST_REPLAY_WINDOW,
  },

  serviceToken: parsed.SERVICE_TOKEN,

  fxApiUrl: parsed.FX_API_URL,

  consumer: {
    batchSize: parsed.CONSUMER_BATCH_SIZE,
    flushIntervalMs: parsed.CONSUMER_FLUSH_INTERVAL_MS,
  },

  dedup: {
    eventNames: parsed.DEDUP_EVENT_NAMES.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ttlSec: parsed.DEDUP_TTL_SEC,
  },

  configDir: parsed.CONFIG_DIR,
  configStore: {
    kind: parsed.CONFIG_STORE,
    dir: parsed.CONFIG_DIR,
    redisPrefix: parsed.CONFIG_REDIS_PREFIX,
  },
  configWriteToken: parsed.CONFIG_WRITE_TOKEN,

  modeler: {
    keyPrefix: parsed.MODELER_KEY_PREFIX,
    concurrency: parsed.MODELER_CONCURRENCY,
    intervalSec: parsed.MODELER_INTERVAL_SEC,
    maxRunAgeSec: parsed.MODELER_MAX_RUN_AGE_SEC,
    lockTtlSec: parsed.MODELER_LOCK_TTL_SEC,
    maxExecutionSec: parsed.MODELER_MAX_EXECUTION_SEC,
    retryDelaysSec: parseDelays(parsed.MODELER_RETRY_DELAYS_SEC, 'MODELER_RETRY_DELAYS_SEC'),
    queryTtlSec: parsed.MODELER_QUERY_TTL_SEC,
    pollMs: parsed.MODELER_POLL_MS,
    once: parsed.MODELER_ONCE === '1',
  },

  webhook: {
    url: parsed.CROBOT_WEBHOOK_URL,
    secret: parsed.CROBOT_WEBHOOK_SECRET,
    retryDelaysSec: parseDelays(
      parsed.CROBOT_WEBHOOK_RETRY_DELAYS_SEC,
      'CROBOT_WEBHOOK_RETRY_DELAYS_SEC',
    ),
  },
} as const;

if (config.webhook.url !== '' && config.webhook.secret.length < 16) {
  throw new Error('CROBOT_WEBHOOK_SECRET (≥16 chars) is required when CROBOT_WEBHOOK_URL is set');
}
