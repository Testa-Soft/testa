/**
 * PRD-006 ingest → storage over the real collector path (task 5.4):
 *   HMAC-signed POST /_ingest (real HTTP) → Redis stream → real Consumer →
 *   ClickHouse `events_buffer` + `event_items`.
 * A purchase with 2 items must land as 1 events row (exp tuples unzipped) and
 * 2 event_items rows.
 *
 * Redis: the shared test DB (REDIS_TEST_DB) under a key prefix unique to this
 * run (stream, group and dedup keys included); only those keys are removed.
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_p2 \
 *   REDIS_URL=redis://localhost:6380 bun test pipeline
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import type { EnrichedEvent } from '@testa-platform/shared-types';
import type { Server } from 'bun';
import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { type PrefixedTestRedis, openPrefixedTestRedis } from '../../__test-utils__/redis.ts';
import { config } from '../../config.ts';
import { command, insertEventItems, insertEvents, query } from '../../db/clickhouse.ts';
import { migrate } from '../../db/migrate.ts';
import { sign } from '../../ingest/hmac.ts';
import { makeIngestHandler } from '../../ingest/route.ts';
import { Consumer } from '../consumer.ts';

const live =
  Boolean(process.env.CLICKHOUSE_URL && process.env.REDIS_URL) &&
  config.clickhouse.database !== 'default';

let redisTest: PrefixedTestRedis;
let redis: Redis;
let server: Server;
let base: string;
const PROJECT_ID = 500_000_000 + Math.floor(Math.random() * 99_000_000);
const GROUP = `test-${randomUUID()}`;

function enriched(overrides: Partial<EnrichedEvent>): EnrichedEvent {
  const now = Date.now();
  return {
    event_id: randomUUID(),
    event_name: 'page_view',
    client_ts: now,
    server_ts: now,
    project_id: PROJECT_ID,
    visitor_id: 'pipe-v1',
    session_id: 'pipe-s1',
    url: 'https://shop.example/thanks',
    consent_state: 'granted',
    tracker_version: '4.1.0',
    viewport_w: 390,
    viewport_h: 844,
    screen_w: 390,
    screen_h: 844,
    exp: [
      [1717, 101, 1_760_433_600, 2],
      [1802, 200, 1_760_431_800, 1],
    ],
    country: 'LT',
    region: '',
    region_subdivision: '',
    city: '',
    device_type: 'mobile',
    browser: 'Mobile Safari',
    os: 'iOS 17.5',
    os_name: 'iOS',
    os_version: '17.5',
    browser_name: 'Safari',
    browser_version: '17',
    referrer_domain: '',
    channel: '',
    is_bot: 0,
    ...overrides,
  };
}

describe.skipIf(!live)(
  `ingest → Redis → consumer → ClickHouse (db=${config.clickhouse.database})`,
  () => {
    beforeAll(async () => {
      const admin = createClient({
        url: config.clickhouse.url,
        username: config.clickhouse.user,
        password: config.clickhouse.password,
      });
      await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}` });
      await admin.close();
      await migrate();
      redisTest = openPrefixedTestRedis('pipeline');
      redis = redisTest.client;
      const app = new Hono();
      app.post('/_ingest', makeIngestHandler({ getRedis: () => redis }));
      server = Bun.serve({ port: 0, fetch: app.fetch });
      base = `http://localhost:${server.port}`;
    });

    afterAll(async () => {
      await redisTest.close(); // removes this run's stream / group / dedup keys only
      server.stop(true);
    });

    it('a purchase with 2 items → 1 events row (exp unzipped) + 2 event_items rows', async () => {
      const purchase = enriched({
        event_name: 'purchase',
        order_id: `O-${randomUUID()}`,
        purchase_type: 'initial',
        value_native: 211.2,
        currency: 'EUR',
        items_count: 3,
        cart_id: 'c_8f2a',
        page_type: 'thank_you',
        items: [
          {
            item_id: 'SW-MER-NVY-M',
            product_id: 'SW-MER',
            item_name: 'Merino Crew Sweater',
            item_variant: 'Navy / M',
            price: 89,
            quantity: 2,
          },
          { item_id: 'SCF-WL-GRY', price: 49, quantity: 1 },
        ],
        props: { coupon: 'AUTUMN10', payment_type: 'card' },
      });
      const view = enriched({
        event_name: 'experiment_view',
        experiment_id: 1717,
        variation_id: 101,
        entry_referrer: 'https://www.google.com/',
        entry_utm_source: 'google',
        click_id_type: 'gclid',
        referrer_domain: 'google.com',
        channel: 'Paid Search',
        visit_number: 2,
      });

      // The consumer group must exist before the XADD so it sees these entries.
      const consumer = new Consumer({
        redis,
        insertEvents,
        insertItems: insertEventItems,
        streamKey: config.redis.streamKey,
        consumerGroup: GROUP,
        consumerName: 'c1',
        batchSize: 100,
        blockMs: 200,
        log: () => {},
      });
      await consumer.ensureGroup();

      const body = JSON.stringify({ signed_at: Date.now(), events: [view, purchase] });
      const res = await fetch(`${base}/_ingest`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-edge-signature': sign(body, config.ingest.sharedSecret),
        },
        body,
      });
      expect(res.status).toBeLessThan(300);

      let flushed = 0;
      for (let i = 0; i < 20 && flushed < 2; i++) flushed += (await consumer.tick()).flushed;
      expect(flushed).toBe(2);
      await command('OPTIMIZE TABLE events_buffer');

      const rows = await query<Record<string, unknown>>(
        `SELECT event_name, exp_ids, exp_var_ids, exp_session_starts, exp_session_idx, purchase_type, order_id,
              cart_id, page_type, screen_w, os_name, browser_name, browser_version, channel, referrer_domain,
              click_id_type, entry_utm_source, visit_number, toString(value_native) AS value, items_count
       FROM events WHERE project_id = {p:UInt64} ORDER BY event_name`,
        { p: PROJECT_ID },
      );
      expect(rows).toHaveLength(2);
      const [view0, purchase0] = [
        rows.find((r) => r.event_name === 'experiment_view'),
        rows.find((r) => r.event_name === 'purchase'),
      ];
      expect(purchase0).toMatchObject({
        exp_ids: ['1717', '1802'],
        exp_var_ids: ['101', '200'],
        exp_session_starts: [1_760_433_600, 1_760_431_800],
        exp_session_idx: [2, 1],
        purchase_type: 'initial',
        order_id: purchase.order_id,
        cart_id: 'c_8f2a',
        page_type: 'thank_you',
        screen_w: 390,
        os_name: 'iOS',
        browser_name: 'Safari',
        browser_version: '17',
        value: '211.2',
        items_count: 3,
      });
      expect(view0).toMatchObject({
        channel: 'Paid Search',
        referrer_domain: 'google.com',
        click_id_type: 'gclid',
        entry_utm_source: 'google',
        visit_number: 2,
      });

      const items = await query<Record<string, unknown>>(
        `SELECT event_id, item_id, product_id, item_variant, toString(price) AS price, quantity, order_id, purchase_type, exp_ids, currency
       FROM event_items WHERE project_id = {p:UInt64} ORDER BY item_id DESC`,
        { p: PROJECT_ID },
      );
      expect(items).toEqual([
        {
          event_id: purchase.event_id,
          item_id: 'SW-MER-NVY-M',
          product_id: 'SW-MER',
          item_variant: 'Navy / M',
          price: '89',
          quantity: 2,
          order_id: purchase.order_id,
          purchase_type: 'initial',
          exp_ids: ['1717', '1802'],
          currency: 'EUR',
        },
        {
          event_id: purchase.event_id,
          item_id: 'SCF-WL-GRY',
          product_id: 'SCF-WL-GRY',
          item_variant: '',
          price: '49',
          quantity: 1,
          order_id: purchase.order_id,
          purchase_type: 'initial',
          exp_ids: ['1717', '1802'],
          currency: 'EUR',
        },
      ]);

      // The experiment_view also fed mv_exposures through the real path.
      const [exposure] = await query<{ seen: string; msi: number }>(
        `SELECT uniqExactMerge(variations_seen) AS seen, max(max_session_idx) AS msi
       FROM exposures WHERE project_id = {p:UInt64} AND experiment_id = 1717`,
        { p: PROJECT_ID },
      );
      expect(exposure).toEqual({ seen: '1', msi: 2 });
    });
  },
);
