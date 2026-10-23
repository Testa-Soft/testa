/**
 * `GET /api/v1/projects/{projectId}/tracking/hits?event=&since=&limit=`
 * (admin v2 CONTRACT "Tracking"): the newest raw hits of one event received
 * after `since`, with their params — for crobot's "listen" mode. Reads
 * `events_buffer` (Buffer + destination), so a hit shows up before the Buffer
 * flushes it into `events`. Items come from `event_items` (written directly).
 */
import type { QueryRunner } from '../analytics/attribution.ts';
import { type HitsParams, chTime, isoTime } from './params.ts';

export interface HitParam {
  name: string;
  value: string;
}

export interface HitItem {
  item_id: string;
  product_id: string;
  price: number;
  quantity: number;
}

export interface TrackingHit {
  event_id: string;
  event: string;
  /** server_ts, ISO-8601. */
  received_at: string;
  /** client_ts, ISO-8601 (the browser's clock). */
  client_ts: string;
  url: string;
  /** Non-empty typed params (order_id, value_native, currency, purchase_type, goal_id), then props. */
  params: HitParam[];
  items: HitItem[];
}

export interface TrackingHitsResponse {
  hits: TrackingHit[];
}

const HITS_SQL = `
SELECT toString(event_id) AS eid, event_name,
       toString(server_ts) AS received_at, toString(client_ts) AS client_at, url,
       order_id, toString(value_native) AS value_native, currency, purchase_type,
       goal_id, props
FROM events_buffer
WHERE project_id = {project_id:UInt64} AND event_name = {event:String}
  AND server_ts > {since:DateTime64(3)}
ORDER BY server_ts DESC, eid
LIMIT {limit:UInt32}`;

const ITEMS_SQL = `
SELECT toString(event_id) AS eid, item_id, product_id,
       toFloat64(price) AS price, toUInt32(quantity) AS quantity
FROM event_items
WHERE project_id = {project_id:UInt64} AND event_name = {event:String}
  AND event_id IN {ids:Array(UUID)}
ORDER BY eid, position, item_id`;

/** Output aliases never reuse a column name (CH would resolve WHERE / IN to the alias). */
interface HitRow {
  eid: string;
  event_name: string;
  received_at: string;
  client_at: string;
  url: string;
  order_id: string;
  value_native: string;
  currency: string;
  purchase_type: string;
  goal_id: string | number;
  props: Record<string, string>;
}

function typedParams(r: HitRow): HitParam[] {
  const typed: [string, string][] = [
    ['order_id', r.order_id],
    ['value_native', Number(r.value_native) === 0 ? '' : r.value_native],
    ['currency', r.currency],
    ['purchase_type', r.purchase_type],
    ['goal_id', Number(r.goal_id) === 0 ? '' : String(r.goal_id)],
  ];
  return typed.filter(([, v]) => v !== '').map(([name, value]) => ({ name, value }));
}

type ItemRow = HitItem & { eid: string };

function toHit(r: HitRow, items: readonly ItemRow[]): TrackingHit {
  const props = Object.entries(r.props ?? {})
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
  return {
    event_id: r.eid,
    event: r.event_name,
    received_at: isoTime(r.received_at),
    client_ts: isoTime(r.client_at),
    url: r.url,
    params: [...typedParams(r), ...props],
    items: items
      .filter((i) => i.eid === r.eid)
      .map(({ item_id, product_id, price, quantity }) => ({
        item_id,
        product_id,
        price: Number(price),
        quantity: Number(quantity),
      })),
  };
}

export async function fetchTrackingHits(
  run: QueryRunner,
  projectId: number,
  p: HitsParams,
): Promise<TrackingHitsResponse> {
  const base = { project_id: projectId, event: p.event };
  const rows = await run<HitRow>(HITS_SQL, { ...base, since: chTime(p.sinceMs), limit: p.limit });
  const ids = rows.map((r) => r.eid);
  const items = ids.length === 0 ? [] : await run<ItemRow>(ITEMS_SQL, { ...base, ids });
  return { hits: rows.map((r) => toHit(r, items)) };
}
