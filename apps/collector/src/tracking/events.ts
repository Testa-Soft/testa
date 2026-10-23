/**
 * `GET /api/v1/projects/{projectId}/tracking/events?events=a,b` (admin v2
 * CONTRACT "Tracking"): per requested event, over the project's RAW events
 * (not experiment-scoped, bots included — "is the site sending it?"):
 *   last_received_at  newest server_ts in the last 30 days, else null
 *   received_24h      events received in the last 24 h
 *   params            coverage over those 24 h: the health spec params for the
 *                     event (always listed), any other typed param seen, every
 *                     non-empty `props` key seen; present_pct is 0..1.
 * Reads `events_buffer` (Buffer + its destination table), so rows waiting for
 * the Buffer flush are counted too.
 */
import { EVENT_PARAM_SPEC, type HealthEventName } from '@testa-platform/shared-types';
import type { QueryRunner } from '../analytics/attribution.ts';
import {
  EVENT_PARAMS,
  EVENT_PARAM_SQL,
  type EventParam,
  ITEM_FIELDS,
  ITEM_FIELD_SQL,
  type ItemField,
} from '../health/query.ts';
import { LOOKBACK_MS, RECENT_MS, chTime, isoTime } from './params.ts';

export interface TrackingParam {
  name: string;
  present_pct: number;
  last_seen_at: string | null;
}

export interface TrackingEvent {
  event: string;
  last_received_at: string | null;
  received_24h: number;
  params: TrackingParam[];
}

export interface TrackingEventsResponse {
  events: TrackingEvent[];
}

const RECENT = 'a.server_ts >= {recent:DateTime64(3)}';
/**
 * `client_ts` lower bounds so ClickHouse can prune partitions / the primary
 * key (`events` is partitioned and ordered on client_ts, not server_ts). The
 * 1-day margin absorbs clock skew; rows whose client clock runs >1 day behind
 * the server fall outside the window (accepted).
 */
const RECENT_PRUNE = 'a.client_ts >= {recent:DateTime64(3)} - INTERVAL 1 DAY';
const LOOKBACK_PRUNE = 'a.client_ts >= {lookback:DateTime64(3)} - INTERVAL 1 DAY';

/**
 * Raw-row presence per typed param: the health checks, except `purchase_type`
 * (health reads the raw row via a subquery on `events` because attribution
 * rewrites it; here `a` IS the raw row) and `items` (bounded to the window).
 */
const PARAM_SQL: Record<EventParam, string> = {
  ...EVENT_PARAM_SQL,
  purchase_type: `a.purchase_type != ''`,
  items: `a.event_id IN (SELECT event_id FROM event_items
      WHERE project_id = {project_id:UInt64} AND event_name IN {names:Array(String)}
        AND client_ts >= {lookback:DateTime64(3)} - INTERVAL 1 DAY)`,
};

const EPOCH = '1970-01-01 00:00:00.000';
const pct = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 1e6) / 1e6 : 0);
const seen = (n: number, last: unknown): string | null =>
  n > 0 && typeof last === 'string' && last !== EPOCH ? isoTime(last) : null;

type Row = Record<string, unknown>;

function eventsSql(): string {
  const cols = EVENT_PARAMS.flatMap((p) => [
    `toUInt64(countIf(${RECENT} AND ${PARAM_SQL[p]})) AS p_${p}`,
    `toString(maxIf(a.server_ts, ${RECENT} AND ${PARAM_SQL[p]})) AS l_${p}`,
  ]);
  return `
SELECT a.event_name AS event_name,
       toString(max(a.server_ts)) AS last_received_at,
       toUInt64(countIf(${RECENT})) AS received_24h,
       ${cols.join(',\n       ')}
FROM events_buffer AS a
WHERE a.project_id = {project_id:UInt64} AND a.event_name IN {names:Array(String)}
  AND a.server_ts >= {lookback:DateTime64(3)} AND ${LOOKBACK_PRUNE}
GROUP BY event_name`;
}

const PROPS_SQL = `
SELECT a.event_name AS event_name, k AS name,
       toUInt64(count()) AS n, toString(max(a.server_ts)) AS last
FROM events_buffer AS a ARRAY JOIN mapKeys(a.props) AS k
WHERE a.project_id = {project_id:UInt64} AND a.event_name IN {names:Array(String)}
  AND ${RECENT} AND ${RECENT_PRUNE} AND a.props[k] != ''
GROUP BY event_name, name
ORDER BY event_name, name
LIMIT 50 BY event_name`;

function itemsSql(): string {
  const cols = ITEM_FIELDS.flatMap((f) => [
    `toUInt64(countIf(${ITEM_FIELD_SQL[f]})) AS f_${f}`,
    `toString(maxIf(e.server_ts, ${ITEM_FIELD_SQL[f]})) AS lf_${f}`,
  ]);
  return `
SELECT i.event_name AS event_name, toUInt64(count()) AS items,
       ${cols.join(',\n       ')}
FROM event_items AS i
INNER JOIN (
  SELECT a.event_id AS event_id, a.server_ts AS server_ts
  FROM events_buffer AS a
  WHERE a.project_id = {project_id:UInt64} AND a.event_name IN {names:Array(String)}
    AND ${RECENT} AND ${RECENT_PRUNE}
) AS e ON e.event_id = i.event_id
WHERE i.project_id = {project_id:UInt64} AND i.event_name IN {names:Array(String)}
GROUP BY event_name`;
}

const specOf = (event: string): readonly string[] =>
  (EVENT_PARAM_SPEC as Record<string, readonly string[]>)[event as HealthEventName] ?? [];

function eventParams(
  event: string,
  row: Row | undefined,
  items: Row | undefined,
  props: readonly Row[],
): TrackingParam[] {
  const received = Number(row?.received_24h ?? 0);
  const spec = specOf(event);
  const itemRows = Number(items?.items ?? 0);
  const typed = EVENT_PARAMS.filter(
    (p) => spec.includes(p) || Number(row?.[`p_${p}`] ?? 0) > 0,
  ).map((p) => {
    const n = Number(row?.[`p_${p}`] ?? 0);
    return { name: p, present_pct: pct(n, received), last_seen_at: seen(n, row?.[`l_${p}`]) };
  });
  const itemFields = ITEM_FIELDS.filter((f) => spec.includes(`items[].${f}`) || itemRows > 0).map(
    (f: ItemField) => {
      const n = Number(items?.[`f_${f}`] ?? 0);
      return {
        name: `items[].${f}`,
        present_pct: pct(n, itemRows),
        last_seen_at: seen(n, items?.[`lf_${f}`]),
      };
    },
  );
  const known = new Set([...typed, ...itemFields].map((p) => p.name));
  const custom = props
    .filter((p) => !known.has(String(p.name)))
    .map((p) => ({
      name: String(p.name),
      present_pct: pct(Number(p.n), received),
      last_seen_at: seen(Number(p.n), p.last),
    }));
  return [...typed, ...itemFields, ...custom];
}

export async function fetchTrackingEvents(
  run: QueryRunner,
  projectId: number,
  names: readonly string[],
  nowMs: number,
): Promise<TrackingEventsResponse> {
  const params = {
    project_id: projectId,
    names: [...names],
    recent: chTime(nowMs - RECENT_MS),
    lookback: chTime(nowMs - LOOKBACK_MS),
  };
  const [rows, itemRows, propRows] = await Promise.all([
    run<Row>(eventsSql(), params),
    run<Row>(itemsSql(), params),
    run<Row>(PROPS_SQL, params),
  ]);
  const byEvent = <T extends Row>(list: readonly T[], name: string) =>
    list.filter((r) => r.event_name === name);
  return {
    events: names.map((event) => {
      const row = byEvent(rows, event)[0];
      return {
        event,
        last_received_at: row ? isoTime(String(row.last_received_at)) : null,
        received_24h: Number(row?.received_24h ?? 0),
        params: eventParams(event, row, byEvent(itemRows, event)[0], byEvent(propRows, event)),
      };
    }),
  };
}
