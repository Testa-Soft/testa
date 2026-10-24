import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@clickhouse/client';
/**
 * PRD-006 ingest end to end over the REAL path, all local processes:
 *
 *   pixel events → POST /track (edge, `wrangler dev`) → Zod + enrich + DO batch
 *   → HMAC POST /_ingest (collector server) → Redis stream → consumer process
 *   → ClickHouse `events` + `event_items` (+ mv_exposures)
 *
 * Asserts the stored rows: exp tuples unzipped, edge-derived os/browser
 * families + channel + referrer_domain, checkout_start alias, items_count,
 * and 2 event_items rows for a 2-item purchase.
 *
 *   CLICKHOUSE_DATABASE=prd006_p2 bun run apps/collector/scripts/prd006-ingest-e2e.ts
 *
 * Env: CLICKHOUSE_URL (default localhost:8123), CLICKHOUSE_DATABASE (required,
 * never `default`), REDIS_URL (default redis://localhost:6380), E2E_COLLECTOR_PORT
 * (18890), E2E_EDGE_PORT (18891). Uses its own Redis stream + consumer group.
 * Exit 0 = pass.
 */
import { type Subprocess, spawn } from 'bun';

const COLLECTOR_DIR = resolve(import.meta.dir, '..');
const EDGE_DIR = resolve(import.meta.dir, '../../edge');
const DB = process.env.CLICKHOUSE_DATABASE ?? '';
const CH_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const COLLECTOR_PORT = Number(process.env.E2E_COLLECTOR_PORT ?? 18890);
const EDGE_PORT = Number(process.env.E2E_EDGE_PORT ?? 18891);
const RUN = randomUUID().slice(0, 8);
const SECRET = `e2e-ingest-secret-${randomUUID()}`;
const PROJECT_ID = 400_000_000 + Math.floor(Math.random() * 99_000_000);
const EXPERIMENT_ID = 300_000_000 + Math.floor(Math.random() * 99_000_000);
const STREAM = `prd006:e2e:${RUN}:events`;
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

if (!DB || DB === 'default') {
  console.error('set CLICKHOUSE_DATABASE to a non-default database (e.g. prd006_p2)');
  process.exit(2);
}

const procs: Subprocess[] = [];
const ch = createClient({ url: CH_URL, database: DB });

function start(name: string, cmd: string[], cwd: string, env: Record<string, string>): void {
  const p = spawn({ cmd, cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  procs.push(p);
  const pipe = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      if (process.env.E2E_VERBOSE)
        process.stderr.write(`[${name}] ${new TextDecoder().decode(chunk)}`);
    }
  };
  void pipe(p.stdout as ReadableStream<Uint8Array>);
  void pipe(p.stderr as ReadableStream<Uint8Array>);
}

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

async function rows<T>(sql: string): Promise<T[]> {
  const rs = await ch.query({ query: sql, query_params: { p: PROJECT_ID }, format: 'JSONEachRow' });
  return (await rs.json()) as T[];
}

function assert(cond: unknown, msg: string, detail?: unknown): void {
  if (!cond)
    throw new Error(`${msg}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function pixelEvent(name: string, extra: Record<string, unknown>) {
  return {
    event_id: randomUUID(),
    event_name: name,
    client_ts: Date.now(),
    project_id: PROJECT_ID,
    visitor_id: `e2e-${RUN}`,
    session_id: `e2e-s-${RUN}`,
    url: 'https://shop.example/product/sw-mer',
    consent_state: 'granted',
    tracker_version: '4.1.0-e2e',
    viewport_w: 390,
    viewport_h: 844,
    screen_w: 390,
    screen_h: 844,
    exp: [[EXPERIMENT_ID, 101, 1_760_433_600, 1]],
    in_experiment: 1,
    ...extra,
  };
}

async function main(): Promise<void> {
  const shared = {
    CLICKHOUSE_URL: CH_URL,
    CLICKHOUSE_DATABASE: DB,
    REDIS_URL,
    REDIS_STREAM_KEY: STREAM,
    INGEST_SHARED_SECRET: SECRET,
  };

  // Schema first (idempotent).
  const migrate = spawn({
    cmd: ['bun', 'run', 'src/db/migrate.ts'],
    cwd: COLLECTOR_DIR,
    env: { ...process.env, ...shared },
  });
  assert((await migrate.exited) === 0, 'migrate failed');

  start('collector', ['bun', 'run', 'src/index.ts'], COLLECTOR_DIR, {
    ...shared,
    PORT: String(COLLECTOR_PORT),
  });
  start('consumer', ['bun', 'run', 'src/consumer/main.ts'], COLLECTOR_DIR, {
    ...shared,
    REDIS_CONSUMER_GROUP: `e2e-${RUN}`,
    CONSUMER_FLUSH_INTERVAL_MS: '200',
  });
  start(
    'edge',
    [
      'npx',
      'wrangler',
      'dev',
      '--port',
      String(EDGE_PORT),
      '--ip',
      '127.0.0.1',
      '--var',
      `INGEST_ORIGIN_URL:http://127.0.0.1:${COLLECTOR_PORT}`,
      '--var',
      `INGEST_SHARED_SECRET:${SECRET}`,
      '--var',
      'COOKIE_FALLBACK_DOMAIN:',
      '--var',
      `VISITOR_ID_SALT:e2e-${RUN}`,
      '--persist-to',
      `.wrangler/e2e-${RUN}`,
    ],
    EDGE_DIR,
    {},
  );

  await waitFor(
    'collector',
    async () => (await fetch(`http://127.0.0.1:${COLLECTOR_PORT}/_internal/live`)).ok,
  );
  await waitFor(
    'edge',
    async () => (await fetch(`http://127.0.0.1:${EDGE_PORT}/health`)).ok,
    90_000,
  );
  // Consumer creates its group at `$` on start: give it a moment before we post.
  await Bun.sleep(1500);

  const orderId = `E2E-${RUN}`;
  const events = [
    pixelEvent('experiment_view', {
      experiment_id: EXPERIMENT_ID,
      variation_id: 101,
      entry_referrer: 'https://www.google.com/',
      entry_url: 'https://shop.example/?gclid=abc',
      entry_utm_source: 'google',
      click_id_type: 'gclid',
      visit_number: 2,
    }),
    pixelEvent('checkout_start', { cart_id: 'c_e2e' }),
    pixelEvent('purchase', {
      order_id: orderId,
      purchase_type: 'initial',
      value_native: 211.2,
      currency: 'EUR',
      cart_id: 'c_e2e',
      items: [
        {
          item_id: 'SW-MER-NVY-M',
          product_id: 'SW-MER',
          item_variant: 'Navy / M',
          price: 89,
          quantity: 2,
        },
        { item_id: 'SCF-WL-GRY', price: 49, quantity: 1 },
      ],
      props: { coupon: 'AUTUMN10', payment_type: 'card' },
    }),
    pixelEvent('purchase', { order_id: 'bad', purchase_type: 'upsell' }), // no parent_order_id → dropped at the edge
  ];
  const res = await fetch(`http://127.0.0.1:${EDGE_PORT}/track`, {
    method: 'POST',
    // Browser-like headers: without Accept-Language the edge's bot heuristic tags is_bot = 1.
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      'accept-language': 'lt-LT,lt;q=0.9,en;q=0.8',
      'cf-ipcountry': 'LT',
    },
    body: JSON.stringify(events),
  });
  assert(res.status === 204, `edge /track answered ${res.status}`);

  await waitFor(
    'rows in ClickHouse',
    async () =>
      (
        await rows<{ n: string }>(
          'SELECT count() AS n FROM events_buffer WHERE project_id = {p:UInt64}',
        )
      )[0]?.n === '3',
  );
  await ch.command({ query: 'OPTIMIZE TABLE events_buffer' });

  const stored = await rows<Record<string, any>>(
    `SELECT event_name, exp_ids, exp_var_ids, exp_session_starts, exp_session_idx, os_name, browser_name,
            browser_version, channel, referrer_domain, click_id_type, visit_number, items_count, order_id,
            purchase_type, country, is_bot
     FROM events WHERE project_id = {p:UInt64} ORDER BY event_name`,
  );
  const by = (name: string) => stored.find((r) => r.event_name === name);
  assert(stored.length === 3, 'expected 3 events (invalid upsell dropped)', stored);
  assert(by('begin_checkout'), 'checkout_start was not normalised to begin_checkout', stored);
  const purchase = by('purchase');
  assert(
    JSON.stringify([
      purchase?.exp_ids,
      purchase?.exp_var_ids,
      purchase?.exp_session_starts,
      purchase?.exp_session_idx,
    ]) === JSON.stringify([[String(EXPERIMENT_ID)], ['101'], [1_760_433_600], [1]]),
    'exp tuples not unzipped',
    purchase,
  );
  assert(
    purchase?.os_name === 'iOS' &&
      purchase?.browser_name === 'Safari' &&
      purchase?.browser_version === '17',
    'UA families',
    purchase,
  );
  assert(
    stored.every((r) => r.is_bot === 0),
    'browser-like traffic was tagged as a bot',
    stored,
  );
  assert(
    purchase?.items_count === 3 && purchase?.order_id === orderId && purchase?.country === 'LT',
    'purchase fields',
    purchase,
  );
  const view = by('experiment_view');
  assert(
    view?.channel === 'Paid Search' &&
      view?.referrer_domain === 'google.com' &&
      view?.click_id_type === 'gclid',
    'edge attribution',
    view,
  );

  const items = await rows<Record<string, any>>(
    `SELECT item_id, product_id, quantity, toString(price) AS price, order_id, exp_ids
     FROM event_items WHERE project_id = {p:UInt64} ORDER BY item_id DESC`,
  );
  assert(items.length === 2, 'expected 2 event_items rows', items);
  assert(
    items[0]?.product_id === 'SW-MER' && items[1]?.product_id === 'SCF-WL-GRY',
    'product_id default',
    items,
  );
  assert(
    items.every((i) => i.order_id === orderId && i.exp_ids[0] === String(EXPERIMENT_ID)),
    'item order/exp',
    items,
  );

  const exposure = await rows<{ v: string }>(
    `SELECT toString(argMinMerge(variation_id)) AS v FROM exposures WHERE project_id = {p:UInt64} AND experiment_id = ${EXPERIMENT_ID}`,
  );
  assert(exposure[0]?.v === '101', 'mv_exposures not fed', exposure);

  console.log(
    JSON.stringify({
      e2e: 'prd006-ingest',
      ok: true,
      project_id: PROJECT_ID,
      events: stored.length,
      items: items.length,
    }),
  );
}

try {
  await main();
} catch (err) {
  console.error(`[e2e] FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  await ch.close();
}
