/**
 * The local stack for `pnpm prd006:validate` (task 5.14 steps 1–4, 9):
 * `docker compose up -d redis clickhouse`, a fresh dedicated ClickHouse
 * database + migrations, a flushed Redis DB index, FX seed, the collector
 * server + consumer + modeler as child processes, and a local webhook
 * receiver. Processes are stopped by the pids this harness recorded, never by
 * port or name, so nothing else on the machine (e.g. tp-collector on :8090)
 * is touched.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chCommand, chPing, chServerCommand } from '../cross/lib/clickhouse.ts';
import { http, waitFor } from '../cross/lib/http.ts';
import { log } from '../cross/lib/log.ts';
import {
  PidFile,
  isAlive,
  portInUse,
  run,
  runOrThrow,
  spawnDetached,
  stopGroup,
} from '../cross/lib/shell.ts';
import { type HarnessConfig, REPO_ROOT, RESETTABLE_DATABASES } from './config.ts';

const PROCS = ['collector', 'consumer', 'modeler'] as const;
/** Query results live this long in the harness (production: 1 h). */
export const QUERY_TTL_SEC = 20;
type Proc = (typeof PROCS)[number];

export const logsDir = (cfg: HarnessConfig): string => join(cfg.artifactsDir, 'logs');
const configDir = (cfg: HarnessConfig): string => join(cfg.artifactsDir, 'configs');

/** Env for every collector process. Fast modeler cadence + retries for the lifecycle flows. */
export function collectorEnv(cfg: HarnessConfig): Record<string, string> {
  return {
    ENVIRONMENT: 'development',
    PORT: String(cfg.args.port),
    CLICKHOUSE_URL: cfg.ch.url,
    CLICKHOUSE_USER: cfg.ch.user,
    CLICKHOUSE_PASSWORD: cfg.ch.password,
    CLICKHOUSE_DATABASE: cfg.ch.database,
    REDIS_URL: cfg.redisUrl,
    REDIS_STREAM_KEY: 'prd006:events',
    REDIS_CONSUMER_GROUP: 'prd006-writers',
    MODELER_KEY_PREFIX: 'prd006:',
    INGEST_SHARED_SECRET: cfg.secrets.ingest,
    SERVICE_TOKEN: cfg.secrets.service,
    CONFIG_DIR: configDir(cfg),
    CONFIG_WRITE_TOKEN: cfg.secrets.config,
    CROBOT_WEBHOOK_URL: `http://127.0.0.1:${cfg.webhookPort}`,
    CROBOT_WEBHOOK_SECRET: cfg.secrets.webhook,
    CROBOT_WEBHOOK_RETRY_DELAYS_SEC: '1,1,1',
    MODELER_INTERVAL_SEC: '5',
    MODELER_POLL_MS: '200',
    MODELER_RETRY_DELAYS_SEC: '1,1,1',
    // Short query TTL so V8/V16 can observe `410 expired` without waiting an hour.
    MODELER_QUERY_TTL_SEC: String(QUERY_TTL_SEC),
    CONSUMER_FLUSH_INTERVAL_MS: '500',
    // No outbound FX calls: the harness seeds rates (validation doc F1).
    FX_API_URL: 'http://127.0.0.1:9',
    FX_SYNC_ON_START: '0',
  };
}

// ─── Redis (raw RESP, so CI needs no redis-cli / docker exec) ───────────────

function parseRedisUrl(url: string): { host: string; port: number; db: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379), db: Number(u.pathname.slice(1) || 0) };
}

const resp = (...args: string[]): string =>
  `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;

/** Send commands, resolve with the raw reply text once `expectReplies` lines arrived. */
async function redisSend(
  url: string,
  commands: string[][],
  expectReplies: number,
): Promise<string> {
  const { host, port } = parseRedisUrl(url);
  return new Promise((resolvePromise, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`Redis ${host}:${port} timed out`)), 5_000);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.write(commands.map((c) => resp(...c)).join(''));
        },
        data(socket, chunk) {
          buf += chunk.toString();
          if (buf.split('\r\n').filter(Boolean).length >= expectReplies) {
            clearTimeout(timer);
            socket.end();
            if (buf.includes('-ERR')) reject(new Error(`Redis: ${buf.trim()}`));
            else resolvePromise(buf);
          }
        },
        error(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
      },
    }).catch(reject);
  });
}

export async function redisPing(url: string): Promise<boolean> {
  try {
    return (await redisSend(url, [['PING']], 1)).startsWith('+PONG');
  } catch {
    return false;
  }
}

/** FLUSHDB on the harness DB index only (never index 0, never FLUSHALL). */
export async function redisFlushDb(url: string): Promise<void> {
  const { db } = parseRedisUrl(url);
  if (db === 0) throw new Error(`refusing to flush Redis DB 0 (${url}); use a dedicated index`);
  await redisSend(url, [['SELECT', String(db)], ['FLUSHDB']], 2);
}

// ─── ClickHouse ─────────────────────────────────────────────────────────────

async function resetDatabase(cfg: HarnessConfig): Promise<number> {
  const db = cfg.ch.database;
  if (!RESETTABLE_DATABASES.test(db)) throw new Error(`refusing to drop ClickHouse database ${db}`);
  await chServerCommand(cfg.ch, `DROP DATABASE IF EXISTS ${db} SYNC`);
  await chServerCommand(cfg.ch, `CREATE DATABASE ${db}`);
  const out = await runOrThrow(['bun', 'run', 'src/db/migrate.ts'], {
    cwd: cfg.collectorDir,
    env: collectorEnv(cfg),
  });
  return Number(/applied=(\d+)/.exec(out)?.[1] ?? 0);
}

/** USD-based rates (fx store convention): USD→EUR 0.9, GBP→EUR 1.15 on every day in range. */
export async function seedFx(cfg: HarnessConfig, from = '2026-09-20', days = 60): Promise<void> {
  const rows: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let d = 0; d < days; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    rows.push(
      `('${date}','USD','EUR',0.9)`,
      `('${date}','USD','GBP',${String(0.9 / 1.15)})`,
      `('${date}','USD','USD',1)`,
    );
  }
  await chCommand(
    cfg.ch,
    `INSERT INTO fx_rates_history (date, from_ccy, to_ccy, rate) VALUES ${rows.join(',')}`,
  );
}

// ─── processes ──────────────────────────────────────────────────────────────

async function startProc(cfg: HarnessConfig, name: Proc, entry: string): Promise<number> {
  const pid = await spawnDetached(['bun', 'run', entry], {
    cwd: cfg.collectorDir,
    env: collectorEnv(cfg),
    logFile: join(logsDir(cfg), `${name}.log`),
  });
  new PidFile(cfg.artifactsDir).set(name, pid);
  log(`started ${name} (pid ${pid})`);
  return pid;
}

export async function stackDown(cfg: HarnessConfig): Promise<void> {
  const pids = new PidFile(cfg.artifactsDir);
  for (const name of PROCS) {
    const pid = pids.read()[name];
    if (pid === undefined) continue;
    if (isAlive(pid)) {
      log(`stopping ${name} (pid ${pid})`);
      await stopGroup(pid);
    }
    pids.remove(name);
  }
}

export interface StackInfo {
  readonly migrations: number;
  readonly modelerAlive: boolean;
}

export async function stackUp(cfg: HarnessConfig): Promise<StackInfo> {
  mkdirSync(logsDir(cfg), { recursive: true });
  mkdirSync(configDir(cfg), { recursive: true });
  await stackDown(cfg);
  // Compose only when a service is down: in a worktree compose gets another
  // project name and would collide with the running tp-* containers.
  const up = (await chPing(cfg.ch)) && (await redisPing(cfg.redisUrl));
  if (!cfg.args.noCompose && !up) {
    await runOrThrow(['docker', 'compose', 'up', '-d', 'redis', 'clickhouse'], { cwd: REPO_ROOT });
  }
  await waitFor('ClickHouse ping', async () => ((await chPing(cfg.ch)) ? true : undefined), {
    timeoutMs: 60_000,
  });
  await waitFor('Redis ping', async () => ((await redisPing(cfg.redisUrl)) ? true : undefined), {
    timeoutMs: 60_000,
  });
  if (await portInUse(cfg.args.port)) {
    throw new Error(
      `port ${cfg.args.port} is in use by a process this harness did not start; pass --port`,
    );
  }
  const migrations = await resetDatabase(cfg);
  log(`ClickHouse ${cfg.ch.database}: fresh, ${migrations} migrations`);
  await redisFlushDb(cfg.redisUrl);
  await seedFx(cfg);
  await startProc(cfg, 'collector', 'src/index.ts');
  await startProc(cfg, 'consumer', 'src/consumer/main.ts');
  await waitFor(
    `collector health on :${cfg.args.port}`,
    async () =>
      (await http({ url: `${cfg.collectorUrl}/_internal/health`, timeoutMs: 2_000 })).status === 200
        ? true
        : undefined,
    { timeoutMs: 30_000 },
  );
  const modeler = await startProc(cfg, 'modeler', 'src/modeler/main.ts');
  await Bun.sleep(2_000);
  return { migrations, modelerAlive: isAlive(modeler) };
}

/** Restart one process (lifecycle flows inject failures by restarting with other env). */
export async function restartProc(
  cfg: HarnessConfig,
  name: Proc,
  extraEnv: Record<string, string>,
): Promise<void> {
  const pid = new PidFile(cfg.artifactsDir).read()[name];
  if (pid !== undefined) await stopGroup(pid);
  const entry = {
    collector: 'src/index.ts',
    consumer: 'src/consumer/main.ts',
    modeler: 'src/modeler/main.ts',
  }[name];
  const next = await spawnDetached(['bun', 'run', entry], {
    cwd: cfg.collectorDir,
    env: { ...collectorEnv(cfg), ...extraEnv },
    logFile: join(logsDir(cfg), `${name}.log`),
  });
  new PidFile(cfg.artifactsDir).set(name, next);
}

// ─── webhook receiver ───────────────────────────────────────────────────────

export interface ReceivedWebhook {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly at: number;
}

export interface WebhookReceiver {
  readonly received: readonly ReceivedWebhook[];
  stop(): void;
}

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function startWebhookReceiver(cfg: HarnessConfig): WebhookReceiver {
  const received: ReceivedWebhook[] = [];
  const server = Bun.serve({
    port: cfg.webhookPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      received.push({
        path: new URL(req.url).pathname,
        headers: headersOf(req.headers),
        body: await req.text(),
        at: Date.now(),
      });
      return new Response('ok');
    },
  });
  return { received, stop: () => server.stop(true) };
}

/** Is a tool on PATH (`bun`, `docker`)? Missing tools stop the run (LOOP.md). */
export async function hasTool(cmd: string[]): Promise<boolean> {
  return (await run(cmd)).code === 0;
}
