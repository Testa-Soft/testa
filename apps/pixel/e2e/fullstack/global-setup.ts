/**
 * Boots the real stack for the PRD-006 full-stack run and records child PIDs
 * (teardown kills exactly those — never anything by name).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CH_DB,
  CH_URL,
  COLLECTOR_DIR,
  COLLECTOR_PORT,
  EDGE_DIR,
  EDGE_PORT,
  PIXEL_DIR,
  REDIS_URL,
  STATE_FILE,
} from './stack.ts';

async function waitFor(what: string, url: string, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`full-stack: timed out waiting for ${what} (${url})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function start(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: process.env.FULLSTACK_VERBOSE ? 'inherit' : 'ignore',
    // Own process group, so teardown can stop the child AND what it spawned
    // (wrangler → workerd) without touching anything else on the machine.
    detached: true,
  });
  child.unref();
  return child;
}

export default async function globalSetup(): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const secret = `fullstack-ingest-${randomUUID()}`;
  const shared = {
    CLICKHOUSE_URL: CH_URL,
    CLICKHOUSE_DATABASE: CH_DB,
    REDIS_URL,
    REDIS_STREAM_KEY: `prd006:p1:${run}:events`,
    INGEST_SHARED_SECRET: secret,
  };

  // Real pixel bundles (loader + runtime).
  execFileSync('node', ['esbuild.config.mjs'], { cwd: PIXEL_DIR, stdio: 'ignore' });
  // Database + schema (idempotent).
  await fetch(`${CH_URL}/`, { method: 'POST', body: `CREATE DATABASE IF NOT EXISTS ${CH_DB}` });
  execFileSync('bun', ['run', 'src/db/migrate.ts'], {
    cwd: COLLECTOR_DIR,
    env: { ...process.env, ...shared },
    stdio: 'ignore',
  });

  const children = [
    start('bun', ['run', 'src/index.ts'], COLLECTOR_DIR, {
      ...shared,
      PORT: String(COLLECTOR_PORT),
    }),
    start('bun', ['run', 'src/consumer/main.ts'], COLLECTOR_DIR, {
      ...shared,
      REDIS_CONSUMER_GROUP: `fullstack-${run}`,
      CONSUMER_FLUSH_INTERVAL_MS: '200',
    }),
    start(
      'npx',
      [
        'wrangler',
        'dev',
        '--port',
        String(EDGE_PORT),
        '--ip',
        '127.0.0.1',
        '--var',
        `INGEST_ORIGIN_URL:http://127.0.0.1:${COLLECTOR_PORT}`,
        '--var',
        `INGEST_SHARED_SECRET:${secret}`,
        '--var',
        'COOKIE_FALLBACK_DOMAIN:',
        '--var',
        `VISITOR_ID_SALT:fullstack-${run}`,
        '--persist-to',
        `.wrangler/fullstack-${run}`,
      ],
      EDGE_DIR,
      {},
    ),
  ];
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ pids: children.map((c) => c.pid).filter(Boolean), run }),
  );

  await waitFor('collector', `http://127.0.0.1:${COLLECTOR_PORT}/_internal/live`);
  await waitFor('edge', `http://127.0.0.1:${EDGE_PORT}/health`);
  // The consumer creates its group at `$` on start; give it a moment.
  await new Promise((r) => setTimeout(r, 1500));
}
