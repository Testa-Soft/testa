/**
 * Tracking API (admin v2) over real HTTP — the full collector app on a random
 * port — against a real ClickHouse. Rows go both into `events` (already
 * flushed) and into `events_buffer` (still buffered: the Buffer holds small
 * inserts up to 30 s), proving both endpoints see unflushed hits.
 *
 *   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=admin_v2_collector bun test tracking
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'bun';
import { config } from '../../config.ts';
import { insertRows, query } from '../../db/clickhouse.ts';
import app from '../../index.ts';
import { database, live, prepareDatabase, randomProjectId } from '../../modeler/__tests__/live.ts';
import { chTime } from '../params.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const projectId = randomProjectId();
const otherProject = projectId + 1;
const BUFFERED_PURCHASE = randomUUID();
const at = (msAgo: number): string => chTime(NOW - msAgo);
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function ev(name: string, msAgo: number, extra: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    client_ts: at(msAgo + 500),
    server_ts: at(msAgo),
    project_id: projectId,
    visitor_id: 'v1',
    session_id: 's1',
    event_name: name,
    url: 'https://shop.example/checkout',
    ...extra,
  };
}

let server: Server;
let base: string;

const get = async (path: string, token: string | null = config.configWriteToken) => {
  const res = await fetch(`${base}/api/v1/projects${path}`, {
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe.skipIf(!live)(`tracking API (live ClickHouse, db=${database}, real HTTP)`, () => {
  beforeAll(async () => {
    await prepareDatabase();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    base = `http://localhost:${server.port}`;
    // Flushed history.
    await insertRows('events', [
      ev('purchase', 2 * HOUR, { order_id: 'o-2', purchase_type: 'initial' }),
      ev('purchase', 10 * DAY, { order_id: 'o-old' }),
      ev('add_to_cart', 5 * DAY, { value_native: 10, currency: 'EUR' }),
      ev('begin_checkout', 40 * DAY),
      { ...ev('purchase', HOUR), project_id: otherProject, order_id: 'other' },
    ]);
    // Still in the Buffer.
    await insertRows('events_buffer', [
      {
        ...ev('purchase', HOUR, {
          order_id: 'o-1',
          value_native: 59.9,
          currency: 'EUR',
          purchase_type: 'initial',
          items_count: 2,
          props: { payment_type: 'card', coupon: '' },
        }),
        event_id: BUFFERED_PURCHASE,
      },
      ev('size_guide_opened', HOUR / 2, { props: { size: 'M', empty: '' } }),
    ]);
    const item = (itemId: string, price: number, position: number) => ({
      event_id: BUFFERED_PURCHASE,
      client_ts: at(HOUR),
      project_id: projectId,
      visitor_id: 'v1',
      session_id: 's1',
      event_name: 'purchase',
      item_id: itemId,
      product_id: `p-${itemId}`,
      price,
      quantity: 1,
      position,
    });
    await insertRows('event_items', [item('sku-1', 39.9, 0), item('sku-2', 0, 1)]);
  });

  afterAll(() => {
    server.stop(true);
  });

  it('the buffered rows have not reached `events` yet (the test proves Buffer reads)', async () => {
    const rows = await query<{ n: string }>(
      'SELECT count() AS n FROM events WHERE project_id = {p:UInt64} AND event_id = {e:UUID}',
      { p: projectId, e: BUFFERED_PURCHASE },
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('401 without / with a wrong Bearer token', async () => {
    for (const token of [null, 'wrong-token']) {
      const res = await get(`/${projectId}/tracking/events?events=purchase`, token);
      expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } });
    }
  });

  it('400 invalid_param with the offending field', async () => {
    const cases: [string, string][] = [
      ['/abc/tracking/events?events=purchase', 'projectId'],
      [`/${projectId}/tracking/events`, 'events'],
      [`/${projectId}/tracking/events?events=purchase,bad%20name`, 'events'],
      [`/${projectId}/tracking/hits`, 'event'],
      [`/${projectId}/tracking/hits?event=purchase&since=yesterday`, 'since'],
      [`/${projectId}/tracking/hits?event=purchase&limit=0`, 'limit'],
      [`/${projectId}/tracking/hits?event=purchase&limit=201`, 'limit'],
    ];
    for (const [path, field] of cases) {
      expect(await get(path)).toEqual({ status: 400, body: { error: 'invalid_param', field } });
    }
  });

  it('GET tracking/events: last_received (30 d), received_24h, param coverage, buffered rows included', async () => {
    const res = await get(
      `/${projectId}/tracking/events?events=purchase,add_to_cart,begin_checkout,size_guide_opened`,
    );
    expect(res.status).toBe(200);
    const events = res.body.events as {
      event: string;
      last_received_at: string | null;
      received_24h: number;
      params: { name: string; present_pct: number; last_seen_at: string | null }[];
    }[];
    expect(events.map((e) => e.event)).toEqual([
      'purchase',
      'add_to_cart',
      'begin_checkout',
      'size_guide_opened',
    ]);
    const [purchase, atc, bc, custom] = events;
    // Newest purchase is the BUFFERED one; the other project's purchase doesn't count.
    expect(purchase?.last_received_at).toBe(iso(HOUR));
    expect(purchase?.received_24h).toBe(2);
    const p = Object.fromEntries((purchase?.params ?? []).map((x) => [x.name, x]));
    expect(Object.keys(p)).toEqual([
      'order_id',
      'value_native',
      'currency',
      'purchase_type',
      'payment_type',
      'items',
      'items[].item_id',
      'items[].price',
      'items[].quantity',
    ]);
    expect(p.order_id).toEqual({ name: 'order_id', present_pct: 1, last_seen_at: iso(HOUR) });
    expect(p.value_native?.present_pct).toBe(0.5);
    expect(p.payment_type?.present_pct).toBe(0.5); // props key, not repeated as custom
    expect(p.items?.present_pct).toBe(0.5);
    expect(p['items[].price']).toEqual({
      name: 'items[].price',
      present_pct: 0.5,
      last_seen_at: iso(HOUR),
    });

    expect(atc).toMatchObject({ last_received_at: iso(5 * DAY), received_24h: 0 });
    expect(atc?.params.every((x) => x.present_pct === 0 && x.last_seen_at === null)).toBe(true);
    expect(bc).toEqual({
      event: 'begin_checkout',
      last_received_at: null,
      received_24h: 0,
      params: [],
    });
    expect(custom).toEqual({
      event: 'size_guide_opened',
      last_received_at: iso(HOUR / 2),
      received_24h: 1,
      params: [{ name: 'size', present_pct: 1, last_seen_at: iso(HOUR / 2) }],
    });
  });

  it('GET tracking/hits: newest first, since / limit, params + items, buffered hit visible', async () => {
    const res = await get(
      `/${projectId}/tracking/hits?event=purchase&since=${encodeURIComponent(iso(3 * HOUR))}`,
    );
    expect(res.status).toBe(200);
    const hits = res.body.hits as Record<string, unknown>[];
    expect(hits.map((h) => h.received_at)).toEqual([iso(HOUR), iso(2 * HOUR)]);
    expect(hits[0]).toEqual({
      event_id: BUFFERED_PURCHASE,
      event: 'purchase',
      received_at: iso(HOUR),
      client_ts: iso(HOUR + 500),
      url: 'https://shop.example/checkout',
      params: [
        { name: 'order_id', value: 'o-1' },
        { name: 'value_native', value: '59.9' },
        { name: 'currency', value: 'EUR' },
        { name: 'purchase_type', value: 'initial' },
        { name: 'payment_type', value: 'card' },
      ],
      items: [
        { item_id: 'sku-1', product_id: 'p-sku-1', price: 39.9, quantity: 1 },
        { item_id: 'sku-2', product_id: 'p-sku-2', price: 0, quantity: 1 },
      ],
    });
    expect(hits[1]?.items).toEqual([]);

    const recent = await get(
      `/${projectId}/tracking/hits?event=purchase&since=${encodeURIComponent(iso(90 * 60_000))}`,
    );
    expect((recent.body.hits as unknown[]).length).toBe(1);
    const limited = await get(`/${projectId}/tracking/hits?event=purchase&limit=1`);
    expect((limited.body.hits as { event_id: string }[]).map((h) => h.event_id)).toEqual([
      BUFFERED_PURCHASE,
    ]);
  });
});
