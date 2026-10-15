/**
 * testa-platform side of the live stack: ClickHouse database `prd006_x0`
 * (dropped, re-created and migrated every run), Redis DB 9, and host
 * processes from `--platform-dir`: collector API :8091, consumer, modeler
 * (when the checkout has one), edge worker via `wrangler dev` :8792.
 *
 * Never touches tp-collector (:8090) or any other database.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chCommand, chPing, chServerCommand } from '../lib/clickhouse.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { http, waitFor } from '../lib/http.ts';
import { log } from '../lib/log.ts';
import { redisPing, redisResetDb } from '../lib/redis.ts';
import {
  PidFile,
  isAlive,
  portInUse,
  run,
  runOrThrow,
  spawnDetached,
  stopGroup,
} from '../lib/shell.ts';

export type ProcState = 'running' | 'missing' | 'exited' | 'disabled' | 'failed';

export interface PlatformStatus {
  readonly migrationsApplied: number;
  readonly modeler: ProcState;
  readonly modelerNote: string;
  readonly edge: ProcState;
  readonly edgeNote: string;
}

const PROCS = ['collector', 'consumer', 'modeler', 'edge'] as const;

export function collectorDir(cfg: HarnessConfig): string {
  return join(cfg.args.platformDir, 'apps', 'collector');
}

/** Env shared by every collector process (server, consumer, modeler, migrate). */
export function collectorEnv(cfg: HarnessConfig): Record<string, string> {
  return {
    ENVIRONMENT: 'development',
    PORT: String(cfg.collector.port),
    CLICKHOUSE_URL: cfg.clickhouse.url,
    CLICKHOUSE_USER: cfg.clickhouse.user,
    CLICKHOUSE_PASSWORD: cfg.clickhouse.password,
    CLICKHOUSE_DATABASE: cfg.clickhouse.database,
    REDIS_URL: cfg.redis.url,
    REDIS_STREAM_KEY: cfg.redis.streamKey,
    REDIS_CONSUMER_GROUP: cfg.redis.consumerGroup,
    REDIS_KEY_PREFIX: cfg.redis.keyPrefix,
    INGEST_SHARED_SECRET: cfg.secrets.ingest,
    SERVICE_TOKEN: cfg.secrets.service,
    METRICS_SERVICE_TOKEN: cfg.secrets.service,
    CONFIG_DIR: cfg.collector.configDir,
    CONFIG_WRITE_TOKEN: cfg.secrets.config,
    CROBOT_WEBHOOK_URL: cfg.crobot.url,
    CROBOT_WEBHOOK_SECRET: cfg.secrets.webhook,
    MODELER_INTERVAL_SEC: '5',
    MODELER_CONCURRENCY: '2',
    CONSUMER_FLUSH_INTERVAL_MS: '1000',
    // No outbound FX calls from the harness: rates are seeded (validation doc F1).
    FX_API_URL: 'http://127.0.0.1:9',
    FX_SYNC_ON_START: '0',
  };
}

async function requirePrereqs(cfg: HarnessConfig): Promise<void> {
  const missing: string[] = [];
  if ((await run(['bun', '--version'])).code !== 0) missing.push('bun');
  if ((await run(['docker', 'info', '--format', '{{.ServerVersion}}'])).code !== 0)
    missing.push('docker daemon');
  if (!existsSync(join(collectorDir(cfg), 'node_modules'))) {
    missing.push(`pnpm install in ${cfg.args.platformDir}`);
  }
  if (!(await chPing(cfg.clickhouse)))
    missing.push(`ClickHouse on ${cfg.clickhouse.url} (tp-clickhouse)`);
  if (!(await redisPing(cfg.redis))) missing.push(`Redis container ${cfg.redis.container}`);
  if (missing.length > 0) throw new Error(`missing prerequisites: ${missing.join(', ')}`);
}

export async function platformDown(cfg: HarnessConfig): Promise<void> {
  const pids = new PidFile(cfg.artifactsDir);
  for (const name of PROCS) {
    const pid = pids.read()[name];
    if (pid !== undefined) {
      if (isAlive(pid)) {
        log(`stopping ${name} (pid ${pid})`);
        await stopGroup(pid);
      }
      pids.remove(name);
    }
  }
}

async function resetData(cfg: HarnessConfig): Promise<number> {
  const db = cfg.clickhouse.database;
  if (!/^prd006_x0$/.test(db)) throw new Error(`refusing to drop database ${db}`);
  await chServerCommand(cfg.clickhouse, `DROP DATABASE IF EXISTS ${db} SYNC`);
  await chServerCommand(cfg.clickhouse, `CREATE DATABASE ${db}`);
  const out = await runOrThrow(['bun', 'run', 'src/db/migrate.ts'], {
    cwd: collectorDir(cfg),
    env: collectorEnv(cfg),
  });
  const applied = Number(/applied=(\d+)/.exec(out)?.[1] ?? 0);
  log(`ClickHouse ${db}: migrated (${applied} migrations)`);
  await seedFx(cfg);
  await redisResetDb(cfg.redis);
  return applied;
}

/**
 * F1 FX: USD→EUR 0.9 on every day around the fixture (and GBP→EUR 1.15), in
 * the store's USD-base convention (`from_ccy = 'USD'`, see apps/collector/src/fx/sync.ts).
 */
async function seedFx(cfg: HarnessConfig): Promise<void> {
  const rows: string[] = [];
  const start = Date.parse('2026-09-20T00:00:00Z');
  for (let d = 0; d < 40; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    rows.push(`('${date}','USD','EUR',0.9)`, `('${date}','USD','GBP',${(0.9 / 1.15).toFixed(8)})`);
    rows.push(`('${date}','USD','USD',1)`);
  }
  await chCommand(
    cfg.clickhouse,
    `INSERT INTO fx_rates_history (date, from_ccy, to_ccy, rate) VALUES ${rows.join(',')}`,
  );
}

async function startProc(
  cfg: HarnessConfig,
  name: (typeof PROCS)[number],
  cmd: readonly string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const pid = await spawnDetached(cmd, {
    cwd,
    env: { ...collectorEnv(cfg), ...extraEnv },
    logFile: join(cfg.logsDir, `${name}.log`),
  });
  new PidFile(cfg.artifactsDir).set(name, pid);
  log(`started ${name} (pid ${pid}, log node_modules/.cache/e2e-cross/logs/${name}.log)`);
  return pid;
}

async function startModeler(cfg: HarnessConfig): Promise<{ state: ProcState; note: string }> {
  const entry = join(collectorDir(cfg), 'src', 'modeler', 'main.ts');
  if (!existsSync(entry))
    return { state: 'missing', note: 'apps/collector/src/modeler/main.ts not in checkout' };
  const pid = await startProc(
    cfg,
    'modeler',
    ['bun', 'run', 'src/modeler/main.ts'],
    collectorDir(cfg),
  );
  await Bun.sleep(4_000);
  if (!isAlive(pid))
    return { state: 'exited', note: 'modeler process exited right after start (stub?)' };
  return { state: 'running', note: '' };
}

async function startEdge(cfg: HarnessConfig): Promise<{ state: ProcState; note: string }> {
  if (!cfg.args.edge) return { state: 'disabled', note: '--no-edge' };
  const edgeDir = join(cfg.args.platformDir, 'apps', 'edge');
  if (await portInUse(cfg.edge.port))
    return { state: 'failed', note: `port ${cfg.edge.port} already in use` };
  const pid = await startProc(
    cfg,
    'edge',
    [
      'pnpm',
      'exec',
      'wrangler',
      'dev',
      '--port',
      String(cfg.edge.port),
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      String(cfg.edge.inspectorPort),
      '--persist-to',
      join(cfg.artifactsDir, 'wrangler-state'),
      '--var',
      `INGEST_ORIGIN_URL:${cfg.collector.url}`,
      '--var',
      `INGEST_SHARED_SECRET:${cfg.secrets.ingest}`,
      '--var',
      'COOKIE_FALLBACK_DOMAIN:.localhost',
      '--var',
      'VISITOR_ID_SALT:x0-local-salt',
    ],
    edgeDir,
    { WRANGLER_SEND_METRICS: 'false', CI: '1' },
  );
  try {
    await waitFor(
      'edge /health',
      async () =>
        (await http({ url: `${cfg.edge.url}/health`, timeoutMs: 2_000 })).status === 200
          ? true
          : undefined,
      { timeoutMs: 60_000 },
    );
    return { state: 'running', note: '' };
  } catch (err) {
    return { state: isAlive(pid) ? 'failed' : 'exited', note: (err as Error).message };
  }
}

export async function platformUp(cfg: HarnessConfig): Promise<PlatformStatus> {
  await requirePrereqs(cfg);
  await platformDown(cfg);
  if (await portInUse(cfg.collector.port)) {
    throw new Error(`port ${cfg.collector.port} is in use by a process the harness did not start`);
  }
  const migrationsApplied = await resetData(cfg);
  const dir = collectorDir(cfg);
  await startProc(cfg, 'collector', ['bun', 'run', 'src/index.ts'], dir);
  await startProc(cfg, 'consumer', ['bun', 'run', 'src/consumer/main.ts'], dir);
  await waitFor(
    `collector health on :${cfg.collector.port}`,
    async () => {
      const res = await http({ url: `${cfg.collector.url}/_internal/health`, timeoutMs: 2_000 });
      return res.status === 200 ? true : undefined;
    },
    { timeoutMs: 30_000 },
  );
  const modeler = await startModeler(cfg);
  const edge = await startEdge(cfg);
  return {
    migrationsApplied,
    modeler: modeler.state,
    modelerNote: modeler.note,
    edge: edge.state,
    edgeNote: edge.note,
  };
}
