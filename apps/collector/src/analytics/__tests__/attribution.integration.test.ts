/**
 * Attribution core against a real ClickHouse with the hand-computed F1 fixture
 * (`docs/prds/006-validation.md`, rows from `docs/reference/samples/f1/raw/events.jsonl`).
 *
 * F1 rows are inserted straight into `events` (which fires mv_exposures) under a
 * fresh random project_id per run, then the builders run through the real client.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p0 bun test src/analytics
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@clickhouse/client';
import { config } from '../../config.ts';
import { close, insertRows, query } from '../../db/clickhouse.ts';
import { migrate } from '../../db/migrate.ts';
import {
  type QueryRunner,
  buildAttributedEvents,
  buildExposedVisitors,
  fetchQuality,
} from '../attribution.ts';

const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;
const database = config.clickhouse.database;
const live = Boolean(liveCh) && database !== 'default';

const F1_EVENTS = resolve(
  import.meta.dir,
  '../../../../../docs/reference/samples/f1/raw/events.jsonl',
);
const PROJECT_ID = 800_000_000 + Math.floor(Math.random() * 1_000_000);
const SCOPE = { projectId: PROJECT_ID, experimentId: 1717, from: '2026-10-01', to: '2026-10-03' };

const run: QueryRunner = (sql, params) => query(sql, params);

async function ensureDatabase(): Promise<void> {
  const admin = createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.user,
    password: config.clickhouse.password,
  });
  try {
    await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${database}` });
  } finally {
    await admin.close();
  }
}

function f1Rows(): Record<string, unknown>[] {
  return readFileSync(F1_EVENTS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => ({ ...(JSON.parse(line) as Record<string, unknown>), project_id: PROJECT_ID }));
}

describe.skipIf(!live)(`attribution core (live ClickHouse, db=${database})`, () => {
  beforeAll(async () => {
    await ensureDatabase();
    await migrate();
    await insertRows('events', f1Rows());
  });

  afterAll(async () => {
    await close();
  });

  it('exposed set: 3 / 3 visitors for 1717; v4 (contaminated) and v9 (bot) excluded', async () => {
    const q = buildExposedVisitors({ ...SCOPE, dims: ['screen_resolution', 'visitor_type'] });
    const rows = await run<Record<string, unknown>>(q.sql, q.params);
    expect(rows).toEqual([
      v('v1', '100', '2026-10-01', 'new'),
      v('v2', '101', '2026-10-01', 'new'),
      v('v3', '101', '2026-10-01', 'returning'),
      v('v6', '100', '2026-10-02', 'new'),
      v('v7', '100', '2026-10-02', 'new'),
      v('v8', '101', '2026-10-02', 'new'),
    ]);
  });

  it('a range that starts on D2 drops D1 first exposures (even if they return later)', async () => {
    const q = buildExposedVisitors({ ...SCOPE, from: '2026-10-02' });
    const rows = await run<{ visitor_id: string }>(q.sql, q.params);
    expect(rows.map((r) => r.visitor_id)).toEqual(['v6', 'v7', 'v8']);
  });

  it('attributed purchases: O1 once, O6 (empty exp) not attributed, credited to first-exposure date', async () => {
    const q = buildAttributedEvents({ ...SCOPE, eventNames: ['purchase'] });
    const rows = await run<Record<string, unknown>>(q.sql, q.params);
    const picked = rows.map((r) => ({
      visitor_id: r.visitor_id,
      order_id: r.order_id,
      purchase_type: r.purchase_type,
      variation_id: r.variation_id,
      date: r.date,
      client_ts: r.client_ts,
    }));
    expect(picked).toEqual([
      p('v1', 'O1', 'initial', '100', '2026-10-01', '2026-10-01 10:10:00.000'),
      p('v2', 'O2', 'initial', '101', '2026-10-01', '2026-10-01 11:10:00.000'),
      p('v2', 'O2-U1', 'upsell', '101', '2026-10-01', '2026-10-01 11:12:00.000'),
      // v3 bought on D3 in a new session; credited to the D1 first exposure.
      p('v3', 'O3', 'initial', '101', '2026-10-01', '2026-10-03 09:20:00.000'),
    ]);
  });

  it('attribution follows the exposure variation, not the stamped one (v8)', async () => {
    const q = buildAttributedEvents({
      ...SCOPE,
      eventNames: ['add_to_cart'],
      dims: ['device_type'],
    });
    const rows = await run<Record<string, unknown>>(q.sql, q.params);
    expect(
      rows.map((r) => [r.visitor_id, r.variation_id, r.stamped_variation_id, r.dim_device_type]),
    ).toEqual([
      ['v1', '100', '100', 'desktop'],
      ['v8', '101', '100', 'desktop'],
    ]);
  });

  it('every attributed row carries its visitor first-exposure date', async () => {
    const exposed = buildExposedVisitors(SCOPE);
    const dates = new Map(
      (await run<{ visitor_id: string; date: string }>(exposed.sql, exposed.params)).map((r) => [
        r.visitor_id,
        r.date,
      ]),
    );
    const q = buildAttributedEvents(SCOPE);
    const rows = await run<{ visitor_id: string; date: string; event_name: string }>(
      q.sql,
      q.params,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.date).toBe(dates.get(row.visitor_id) as string);
    // v5 (other experiment), v4 (contaminated), v9 (bot) never appear.
    expect(new Set(rows.map((r) => r.visitor_id))).toEqual(
      new Set(['v1', 'v2', 'v3', 'v6', 'v7', 'v8']),
    );
  });

  it('quality: 1 multi-variation visitor, 1 variation-mismatch event', async () => {
    expect(await fetchQuality(run, SCOPE)).toEqual({
      multi_variation_visitors: 1,
      variation_mismatch_events: 1,
    });
  });
});

function v(visitor: string, variation: string, date: string, visitorType: string) {
  return {
    visitor_id: visitor,
    variation_id: variation,
    first_exposed_at: expect.any(String),
    date,
    dim_screen_resolution: '1512x982',
    dim_visitor_type: visitorType,
  };
}

function p(
  visitor: string,
  order: string,
  type: string,
  variation: string,
  date: string,
  ts: string,
) {
  return {
    visitor_id: visitor,
    order_id: order,
    purchase_type: type,
    variation_id: variation,
    date,
    client_ts: ts,
  };
}
