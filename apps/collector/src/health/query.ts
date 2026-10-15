/**
 * ClickHouse reads for the `health` view (PRD-006 §6.5, task 5.17).
 *
 * Health counts RAW attributed events: `buildAttributedEvents` with
 * `dedupePurchases: false`, because a reload duplicate is still an event the
 * site sent (006-validation F1: "v1 incl. duplicate"; oracle
 * `generate.py health()`: "duplicates included").
 */
import { EVENT_PARAM_SPEC, type HealthEventName } from '@testa-platform/shared-types';
import {
  type AttributionScope,
  type QueryRunner,
  buildAttributedEvents,
  buildExposedVisitors,
} from '../analytics/attribution.ts';

type SpecParam = (typeof EVENT_PARAM_SPEC)[HealthEventName][number];
export type ItemField = SpecParam extends `items[].${infer F}` ? F : never;
export type EventParam = Exclude<SpecParam, `items[].${string}`>;

/**
 * Presence test per event-level param, on an attributed event `a`. Typed: a
 * new spec param fails typecheck. `purchase_type` is read from the raw row,
 * since attribution reports '' on a purchase as `initial`.
 */
const EVENT_PARAM_SQL: Record<EventParam, string> = {
  order_id: `a.order_id != ''`,
  value_native: 'a.value_native != 0',
  currency: `a.currency != ''`,
  purchase_type: `a.event_id IN (SELECT event_id FROM events WHERE project_id = {project_id:UInt64} AND purchase_type != '')`,
  payment_type: `a.props['payment_type'] != ''`,
  // An event "has items" when it wrote at least one event_items row.
  items: 'a.event_id IN (SELECT event_id FROM event_items WHERE project_id = {project_id:UInt64})',
};

/**
 * Presence test per item field, on `event_items AS i`. Columns are not
 * Nullable: a missing price is stored as 0 and a missing quantity as the
 * default 1, so quantity is effectively always present.
 */
const ITEM_FIELD_SQL: Record<ItemField, string> = {
  item_id: `i.item_id != ''`,
  price: 'i.price != 0',
  quantity: 'i.quantity > 0',
};

export const EVENT_PARAMS = Object.keys(EVENT_PARAM_SQL) as EventParam[];
export const ITEM_FIELDS = Object.keys(ITEM_FIELD_SQL) as ItemField[];

export interface EventRow {
  event_name: string;
  variation_id: number;
  events: number;
  visitors: number;
  last_event_at: string;
  /** Events where each event-level param is present. */
  present: Record<EventParam, number>;
}

export interface ItemRow {
  event_name: string;
  items: number;
  present: Record<ItemField, number>;
}

export interface HealthRows {
  events: EventRow[];
  items: ItemRow[];
  /** Exposed visitors per variation (SRM input). */
  exposed: { variation_id: number; visitors: number }[];
}

const presentCols = (sql: Record<string, string>, prefix: string): string =>
  Object.entries(sql)
    .map(([name, cond]) => `toUInt32(countIf(${cond})) AS ${prefix}${name}`)
    .join(',\n      ');

const num = (v: unknown): number => Number(v ?? 0);

const pick = <K extends string>(row: Record<string, unknown>, keys: K[], prefix: string) =>
  Object.fromEntries(keys.map((k) => [k, num(row[`${prefix}${k}`])])) as Record<K, number>;

export async function fetchHealthRows(
  query: QueryRunner,
  scope: AttributionScope,
): Promise<HealthRows> {
  const exposed = buildExposedVisitors(scope);
  const attributed = buildAttributedEvents({
    ...scope,
    eventNames: Object.keys(EVENT_PARAM_SPEC),
    dedupePurchases: false,
  });

  const [eventRows, itemRows, exposedRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT
      a.event_name AS event_name,
      toUInt32(a.variation_id) AS variation_id,
      toUInt32(count()) AS events,
      toUInt32(uniqExact(a.visitor_id)) AS visitors,
      toString(max(a.client_ts)) AS last_event_at,
      ${presentCols(EVENT_PARAM_SQL, 'p_')}
    FROM (${attributed.sql}) AS a
    GROUP BY event_name, variation_id
    ORDER BY event_name, variation_id`,
      attributed.params,
    ),
    query<Record<string, unknown>>(
      `SELECT
      i.event_name AS event_name,
      toUInt32(count()) AS items,
      ${presentCols(ITEM_FIELD_SQL, 'f_')}
    FROM event_items AS i
    WHERE i.project_id = {project_id:UInt64}
      AND i.event_id IN (SELECT event_id FROM (${attributed.sql}))
    GROUP BY event_name
    ORDER BY event_name`,
      attributed.params,
    ),
    query<Record<string, unknown>>(
      `SELECT toUInt32(variation_id) AS variation_id, toUInt32(count()) AS visitors
    FROM (${exposed.sql})
    GROUP BY variation_id
    ORDER BY variation_id`,
      exposed.params,
    ),
  ]);

  return {
    events: eventRows.map((r) => ({
      event_name: String(r.event_name),
      variation_id: num(r.variation_id),
      events: num(r.events),
      visitors: num(r.visitors),
      last_event_at: String(r.last_event_at),
      present: pick(r, EVENT_PARAMS, 'p_'),
    })),
    items: itemRows.map((r) => ({
      event_name: String(r.event_name),
      items: num(r.items),
      present: pick(r, ITEM_FIELDS, 'f_'),
    })),
    exposed: exposedRows.map((r) => ({
      variation_id: num(r.variation_id),
      visitors: num(r.visitors),
    })),
  };
}
