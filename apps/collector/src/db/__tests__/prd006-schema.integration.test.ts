/**
 * PRD-006 schema (migrations 013–023, task 5.2) against a real ClickHouse.
 *
 * Runs the real migrate runner against `CLICKHOUSE_DATABASE` (never `default`),
 * inserts one experiment_view + one purchase through `events_buffer`, forces
 * the Buffer flush, and asserts that the new columns round-trip into `events`,
 * that `mv_exposures` aggregates correctly, and that `event_items` accepts rows.
 *
 * Live-only, like the rest of the collector suite:
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p0 bun test prd006-schema
 * Isolation: every run uses a fresh random project_id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { config } from '../../config.ts';
import { close, command, insertRows, query } from '../clickhouse.ts';
import { migrate } from '../migrate.ts';

const liveCh = process.env.CLICKHOUSE_URL ?? process.env.RUN_LIVE_CH;
const database = config.clickhouse.database;
const live = Boolean(liveCh) && database !== 'default';

const PROJECT_ID = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const EXPERIMENT_ID = 1717;
const VISITOR = `v-${randomUUID()}`;
const SESSION_START = 1_759_309_200; // 2025-10-01 09:00:00 UTC

/** Create the database through a client that isn't bound to it. */
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

function baseRow(eventName: string, clientTs: string, extra: Record<string, unknown>) {
  return {
    event_id: randomUUID(),
    client_ts: clientTs,
    server_ts: clientTs,
    project_id: PROJECT_ID,
    visitor_id: VISITOR,
    session_id: 's-1',
    event_name: eventName,
    url: 'https://shop.example/p/sw-mer',
    exp_ids: [EXPERIMENT_ID],
    exp_var_ids: [101],
    exp_session_starts: [SESSION_START],
    exp_session_idx: [2],
    in_experiment: 1,
    screen_w: 390,
    screen_h: 844,
    country: 'LT',
    device_type: 'mobile',
    os_name: 'iOS',
    os_version: '17.5',
    browser_name: 'Safari',
    browser_version: '17.5',
    ...extra,
  };
}

describe.skipIf(!live)(`PRD-006 schema (live ClickHouse, db=${database})`, () => {
  beforeAll(async () => {
    await ensureDatabase();
    const first = await migrate();
    // Re-running is a no-op.
    const second = await migrate();
    expect(second.applied).toEqual([]);
    expect(first.skipped.length + first.applied.length).toBe(second.skipped.length);
  });

  afterAll(async () => {
    await close();
  });

  it('applies 001–025 and drops the old revenue MVs', async () => {
    const files = await query<{ filename: string }>(
      'SELECT filename FROM _migrations ORDER BY filename',
    );
    const names = files.map((f) => f.filename);
    expect(names.at(-1)).toBe('025_metric_daily_count_sq_visitor.sql');
    expect(names).toHaveLength(25);

    const tables = await query<{ name: string }>(
      'SELECT name FROM system.tables WHERE database = currentDatabase()',
    );
    const tableNames = tables.map((t) => t.name);
    for (const t of [
      'exposures',
      'mv_exposures',
      'event_items',
      'metric_subscriptions',
      'metric_daily',
    ]) {
      expect(tableNames).toContain(t);
    }
    for (const gone of ['mv_aov_daily', 'mv_rpv_revenue_daily', 'mv_rpv_visitors_daily']) {
      expect(tableNames).not.toContain(gone);
    }
    expect(tableNames).toContain('mv_sessions_daily');
    expect(tableNames).toContain('mv_experiment_summary');
  });

  it('has idx_exp on events only and the 1-day / 13-month page_view TTL (024)', async () => {
    const idx = await query<{ table: string }>(
      `SELECT table FROM system.data_skipping_indices
       WHERE database = currentDatabase() AND name = 'idx_exp'`,
    );
    expect(idx.map((r) => r.table)).toEqual(['events']);

    const [ddl] = await query<{ create_table_query: string }>(
      `SELECT create_table_query FROM system.tables
       WHERE database = currentDatabase() AND name = 'events'`,
    );
    expect(ddl?.create_table_query).not.toContain('toIntervalDay(90)');
    expect(ddl?.create_table_query).toContain('toIntervalDay(1)');
    expect(ddl?.create_table_query).toContain('toIntervalMonth(13)');
  });

  it('round-trips new columns through events_buffer and aggregates exposures', async () => {
    await insertRows('events_buffer', [
      baseRow('experiment_view', '2025-10-01 09:00:00.000', {
        experiment_id: EXPERIMENT_ID,
        variation_id: 101,
        channel: 'Paid Search',
        referrer_domain: 'google.com',
        click_id_type: 'gclid',
        entry_referrer: 'https://www.google.com/',
        entry_url: 'https://shop.example/?utm_source=google',
        entry_utm_source: 'google',
        entry_utm_medium: 'cpc',
        entry_utm_campaign: 'autumn',
        entry_utm_term: 'merino',
        entry_utm_content: 'ad-1',
        visit_number: 3,
      }),
      // Second exposure later, same variation, a new experiment session.
      baseRow('experiment_view', '2025-10-03 10:00:00.000', {
        experiment_id: EXPERIMENT_ID,
        variation_id: 101,
        exp_session_starts: [SESSION_START + 2 * 86_400],
        exp_session_idx: [3],
        channel: 'Direct',
        country: 'DE',
      }),
      baseRow('purchase', '2025-10-03 10:05:00.000', {
        order_id: 'ORD-1',
        purchase_type: 'initial',
        value_native: 211.2,
        currency: 'EUR',
        cart_id: 'c_8f2a',
        page_type: 'thank_you',
        goal_id: 0,
        utm_term: 'merino',
        utm_content: 'ad-1',
      }),
      baseRow('purchase', '2025-10-03 10:06:00.000', {
        order_id: 'ORD-1-U1',
        purchase_type: 'upsell',
        parent_order_id: 'ORD-1',
        value_native: 24,
        currency: 'EUR',
      }),
    ]);
    // Force the Buffer flush into `events` (which also fires mv_exposures).
    await command('OPTIMIZE TABLE events_buffer');

    const purchases = await query<Record<string, unknown>>(
      `SELECT order_id, purchase_type, parent_order_id, cart_id, page_type, utm_term, utm_content,
              exp_ids, exp_var_ids, exp_session_starts, exp_session_idx, screen_w, screen_h,
              os_name, os_version, browser_name, browser_version, toString(value_native) AS value
       FROM events
       WHERE project_id = {p:UInt64} AND event_name = 'purchase' AND has(exp_ids, {e:UInt64})
       ORDER BY order_id`,
      { p: PROJECT_ID, e: EXPERIMENT_ID },
    );
    expect(purchases).toEqual([
      {
        order_id: 'ORD-1',
        purchase_type: 'initial',
        parent_order_id: '',
        cart_id: 'c_8f2a',
        page_type: 'thank_you',
        utm_term: 'merino',
        utm_content: 'ad-1',
        exp_ids: [String(EXPERIMENT_ID)],
        exp_var_ids: ['101'],
        exp_session_starts: [SESSION_START],
        exp_session_idx: [2],
        screen_w: 390,
        screen_h: 844,
        os_name: 'iOS',
        os_version: '17.5',
        browser_name: 'Safari',
        browser_version: '17.5',
        value: '211.2',
      },
      expect.objectContaining({
        order_id: 'ORD-1-U1',
        purchase_type: 'upsell',
        parent_order_id: 'ORD-1',
      }),
    ]);

    const [view] = await query<Record<string, unknown>>(
      `SELECT entry_referrer, entry_url, entry_utm_source, entry_utm_medium, entry_utm_campaign,
              entry_utm_term, entry_utm_content, click_id_type, channel, referrer_domain, visit_number
       FROM events
       WHERE project_id = {p:UInt64} AND event_name = 'experiment_view'
       ORDER BY client_ts LIMIT 1`,
      { p: PROJECT_ID },
    );
    expect(view).toEqual({
      entry_referrer: 'https://www.google.com/',
      entry_url: 'https://shop.example/?utm_source=google',
      entry_utm_source: 'google',
      entry_utm_medium: 'cpc',
      entry_utm_campaign: 'autumn',
      entry_utm_term: 'merino',
      entry_utm_content: 'ad-1',
      click_id_type: 'gclid',
      channel: 'Paid Search',
      referrer_domain: 'google.com',
      visit_number: 3,
    });

    const exposures = await query<Record<string, unknown>>(
      `SELECT visitor_id,
              toString(min(first_exposed_at))          AS first_exposed_at,
              argMinMerge(variation_id)                AS variation_id,
              uniqExactMerge(variations_seen)          AS variations_seen,
              uniqExactMerge(sessions)                 AS sessions,
              max(max_session_idx)                     AS max_session_idx,
              argMinMerge(channel)                     AS channel,
              argMinMerge(referrer_domain)             AS referrer_domain,
              argMinMerge(utm_source)                  AS utm_source,
              argMinMerge(utm_medium)                  AS utm_medium,
              argMinMerge(utm_campaign)                AS utm_campaign,
              argMinMerge(utm_term)                    AS utm_term,
              argMinMerge(utm_content)                 AS utm_content,
              argMinMerge(country)                     AS country,
              argMinMerge(device_type)                 AS device_type,
              argMinMerge(os_name)                     AS os_name,
              argMinMerge(browser_name)                AS browser_name,
              argMinMerge(screen_resolution)           AS screen_resolution
       FROM exposures
       WHERE project_id = {p:UInt64} AND experiment_id = {e:UInt64}
       GROUP BY visitor_id`,
      { p: PROJECT_ID, e: EXPERIMENT_ID },
    );
    expect(exposures).toEqual([
      {
        visitor_id: VISITOR,
        first_exposed_at: '2025-10-01 09:00:00.000',
        variation_id: '101',
        variations_seen: '1',
        sessions: '2',
        max_session_idx: 3,
        // Dimension snapshot at FIRST exposure, not the later one.
        channel: 'Paid Search',
        referrer_domain: 'google.com',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: 'autumn',
        utm_term: 'merino',
        utm_content: 'ad-1',
        country: 'LT',
        device_type: 'mobile',
        os_name: 'iOS',
        browser_name: 'Safari',
        screen_resolution: '390x844',
      },
    ]);
  });

  it('counts a visitor seen in two variations as variations_seen = 2', async () => {
    const visitor = `v-${randomUUID()}`;
    await insertRows('events_buffer', [
      {
        ...baseRow('experiment_view', '2025-10-02 08:00:00.000', {}),
        visitor_id: visitor,
        experiment_id: EXPERIMENT_ID,
        variation_id: 100,
      },
      {
        ...baseRow('experiment_view', '2025-10-02 09:00:00.000', {}),
        visitor_id: visitor,
        experiment_id: EXPERIMENT_ID,
        variation_id: 101,
      },
    ]);
    await command('OPTIMIZE TABLE events_buffer');
    const [row] = await query<{ variation_id: string; seen: string }>(
      `SELECT argMinMerge(variation_id) AS variation_id, uniqExactMerge(variations_seen) AS seen
       FROM exposures WHERE project_id = {p:UInt64} AND visitor_id = {v:String}`,
      { p: PROJECT_ID, v: visitor },
    );
    expect(row).toEqual({ variation_id: '100', seen: '2' });
  });

  it('round-trips event_items rows', async () => {
    const eventId = randomUUID();
    await insertRows('event_items', [
      {
        event_id: eventId,
        client_ts: '2025-10-03 10:05:00.000',
        project_id: PROJECT_ID,
        visitor_id: VISITOR,
        session_id: 's-1',
        event_name: 'purchase',
        exp_ids: [EXPERIMENT_ID],
        order_id: 'ORD-1',
        purchase_type: 'initial',
        currency: 'EUR',
        item_id: 'SW-MER-NVY-M',
        product_id: 'SW-MER',
        item_name: 'Merino Crew Sweater',
        item_variant: 'Navy / M',
        item_category: 'Apparel',
        price: 89,
        quantity: 2,
      },
    ]);
    const rows = await query<Record<string, unknown>>(
      `SELECT item_id, product_id, item_variant, toString(price) AS price, quantity, discount, position
       FROM event_items WHERE project_id = {p:UInt64} AND has(exp_ids, {e:UInt64})`,
      { p: PROJECT_ID, e: EXPERIMENT_ID },
    );
    expect(rows).toEqual([
      {
        item_id: 'SW-MER-NVY-M',
        product_id: 'SW-MER',
        item_variant: 'Navy / M',
        price: '89',
        quantity: 2,
        discount: 0,
        position: 0,
      },
    ]);
  });
});
