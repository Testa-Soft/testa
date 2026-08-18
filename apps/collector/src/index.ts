/**
 * Collector HTTP server (Bun + Hono).
 *
 * Routes:
 *   POST /_ingest                 HMAC-signed batch from edge worker
 *   GET  /api/v1/metrics/:metric  pre-aggregated metric summaries (Phase 4.1)
 *   GET  /_internal/fx-rates      CH dictionary source (Phase 1.6)
 *   GET  /_internal/live          liveness (always 200, no deps) — Fly health check
 *   GET  /_internal/health        readiness: Redis/CH ping
 */

import { Hono } from 'hono';
import { config } from './config.ts';
import { makeConfigGetHandler, makeConfigPutHandler } from './config/route.ts';
import { fileConfigStore } from './config/store.ts';
import { ping as pingCh } from './db/clickhouse.ts';
import { makeFxRatesHandler } from './fx/route.ts';
import { syncToday } from './fx/sync.ts';
import { makeIngestHandler } from './ingest/route.ts';
import { ping as pingRedis, redis } from './redis/client.ts';

const app = new Hono();

// Liveness: is the process up and serving HTTP? Always 200, no dependencies.
// Fly's health check hits this so a config-only instance (no Redis/CH) stays
// healthy. `/_internal/health` below is the DEEP readiness probe (pings Redis+CH).
app.get('/_internal/live', (c) => c.json({ ok: true, service: 'collector' }));

app.get('/_internal/health', async (c) => {
  const [redisOk, chOk] = await Promise.all([pingRedis(), pingCh().catch(() => false)]);
  const ok = redisOk && chOk;
  return c.json(
    {
      ok,
      service: 'collector',
      environment: config.environment,
      version: config.version,
      checks: { redis: redisOk, clickhouse: chOk },
    },
    ok ? 200 : 503,
  );
});

app.post('/_ingest', makeIngestHandler({ getRedis: () => redis() }));

// Config API — testa-platform is the single source of truth for servable configs.
// The upstream POSTs its project JSON on change; the collector builds + writes a
// static `{projectId}.json` to the config bucket; @testa/next GETs it.
const configStore = fileConfigStore(config.configDir);
app.post(
  '/api/v1/config/:projectId',
  makeConfigPutHandler({ store: configStore, writeToken: config.configWriteToken }),
);
app.get('/api/v1/config/:projectId', makeConfigGetHandler({ store: configStore }));

app.get('/api/v1/metrics/:metric', (c) => c.text('not implemented', 501)); // Phase 4.1

app.get('/_internal/fx-rates', makeFxRatesHandler());

const port = config.port;

console.log(`[collector] starting on :${port} (${config.environment})`);

// FX rate sync schedule (v1: in-process). Production may instead drive
// `syncToday()` via an external cron / k8s CronJob. The 30s startup delay lets
// the CH connection settle before the first pull; failures are logged, never fatal.
const FX_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
if (config.environment !== 'development' || process.env.FX_SYNC_ON_START === '1') {
  setTimeout(() => {
    syncToday().catch((e) => console.error('[fx] initial sync failed', e));
  }, 30_000);
  setInterval(() => {
    syncToday().catch((e) => console.error('[fx] daily sync failed', e));
  }, FX_SYNC_INTERVAL_MS);
}

export default {
  port,
  fetch: app.fetch,
};
