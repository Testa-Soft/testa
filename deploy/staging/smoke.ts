/**
 * Staging smoke: one HMAC-signed event into https://testa-collector-staging.fly.dev/_ingest,
 * then read back from staging ClickHouse (through `fly ssh`, since ClickHouse is private).
 * Smoke rows use project 990042, which no real project uses.
 *
 *   set -a; . ~/.config/testa-staging/secrets.env; set +a
 *   bun deploy/staging/smoke.ts
 */

import type { WireEvent } from '../../scripts/e2e/cross/shared/f1-wire.ts';
import { uuidFor } from '../../scripts/e2e/cross/shared/ids.ts';
import { ingestEvents } from '../../scripts/e2e/cross/shared/ingest-client.ts';

const COLLECTOR = process.env.STAGING_COLLECTOR_URL ?? 'https://testa-collector-staging.fly.dev';
const CH_APP = 'testa-staging-clickhouse';
const SMOKE_PROJECT = 990042;
const TIMEOUT_MS = 60_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '')
    throw new Error(`${name} is not set (source ~/.config/testa-staging/secrets.env)`);
  return v;
}

function smokeEvent(runId: string): WireEvent {
  const now = Date.now();
  return {
    event_id: uuidFor(`staging_smoke|${runId}`),
    event_name: 'staging_smoke',
    client_ts: now,
    server_ts: now,
    project_id: SMOKE_PROJECT,
    visitor_id: `smoke-${runId}`,
    session_id: `smoke-s-${runId}`,
    url: 'https://staging-smoke.example/',
    consent_state: 'granted',
    tracker_version: 'staging-smoke',
    viewport_w: 1280,
    viewport_h: 800,
    country: 'LT',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    is_bot: 0,
  };
}

/** Rows with this event id in staging ClickHouse, via clickhouse-client on the private machine. */
async function countRows(eventId: string): Promise<number> {
  // A bound parameter, so the id needs no quoting through ssh → sh -c.
  const sql = 'SELECT count() FROM events WHERE event_id = {id:UUID}';
  const proc = Bun.spawn(
    [
      'fly',
      'ssh',
      'console',
      '--app',
      CH_APP,
      '-C',
      `sh -c 'clickhouse-client --user testa --password "$CLICKHOUSE_PASSWORD" -d testa --param_id=${eventId} -q "${sql}"'`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`fly ssh failed: ${await new Response(proc.stderr).text()}`);
  const n = Number(out.trim().split('\n').pop());
  if (!Number.isFinite(n)) throw new Error(`unexpected clickhouse-client output: ${out}`);
  return n;
}

async function main(): Promise<void> {
  const secret = requireEnv('INGEST_SHARED_SECRET');
  const ev = smokeEvent(String(Date.now()));
  const res = await ingestEvents(COLLECTOR, secret, [ev]);
  if (res.accepted !== 1) throw new Error(`ingest accepted ${res.accepted}, expected 1`);
  console.log(`ingest accepted ${ev.event_id}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await countRows(ev.event_id)) === 1) {
      console.log('SMOKE OK: event read back from staging ClickHouse');
      return;
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`event ${ev.event_id} not in ClickHouse after ${TIMEOUT_MS / 1000} s`);
}

main().catch((err: unknown) => {
  console.error(`SMOKE FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
