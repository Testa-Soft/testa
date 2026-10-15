/**
 * Map an `EnrichedEvent` (wire format from edge) to a ClickHouse `events` row.
 *
 * Schema source-of-truth: `apps/collector/db/migrations/001_create_events.sql`.
 * Sent via JSONEachRow so column names and string-formatted timestamps must
 * match exactly. Defaults below mirror the table DEFAULT clauses so unspecified
 * fields don't end up as ClickHouse type errors.
 */

import type { EnrichedEvent } from '@testa-platform/shared-types';

export interface EventsRow {
  event_id: string;
  client_ts: string;
  server_ts: string;
  project_id: number;
  experiment_id: number | null;
  variation_id: number | null;
  visitor_id: string;
  session_id: string;
  event_name: string;
  url: string;
  referrer: string;
  country: string;
  region: string;
  region_subdivision: string;
  city: string;
  device_type: string;
  browser: string;
  os: string;
  viewport_w: number;
  viewport_h: number;
  tracker_version: string;
  is_bot: 0 | 1;
  in_experiment: 0 | 1;
  consent_state: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  value_native: number;
  currency: string;
  order_id: string;
  items_count: number;
  props: Record<string, string>;
  // PRD-006 (migration 013): `exp` unzipped into parallel arrays.
  exp_ids: number[];
  exp_var_ids: number[];
  exp_session_starts: number[];
  exp_session_idx: number[];
  goal_id: number;
  purchase_type: string;
  parent_order_id: string;
  page_type: string;
  cart_id: string;
  utm_term: string;
  utm_content: string;
  screen_w: number;
  screen_h: number;
  visit_number: number;
  entry_referrer: string;
  entry_url: string;
  entry_utm_source: string;
  entry_utm_medium: string;
  entry_utm_campaign: string;
  entry_utm_term: string;
  entry_utm_content: string;
  click_id_type: string;
  os_name: string;
  os_version: string;
  browser_name: string;
  browser_version: string;
  referrer_domain: string;
  channel: string;
}

/** One `event_items` row (migration 018): product grain of a commerce event. */
export interface EventItemRow {
  event_id: string;
  client_ts: string;
  project_id: number;
  visitor_id: string;
  session_id: string;
  event_name: string;
  exp_ids: number[];
  order_id: string;
  purchase_type: string;
  currency: string;
  item_id: string;
  product_id: string;
  item_name: string;
  item_variant: string;
  item_brand: string;
  item_category: string;
  item_category2: string;
  item_category3: string;
  price: number;
  quantity: number;
  discount: number;
  item_list_name: string;
  position: number;
}

/** Format a Unix-ms timestamp as `YYYY-MM-DD HH:mm:ss.sss` UTC (DateTime64(3)-friendly). */
function toClickHouseDateTime64(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Stringify all values so the Map(LowCardinality(String), String) column accepts them. */
function stringifyProps(props: EnrichedEvent['props']): Record<string, string> {
  if (!props) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function rowFromEvent(ev: EnrichedEvent): EventsRow {
  // Pre-PRD-006 events (old pixels, in-flight stream entries) have no exp.
  const exp = ev.exp ?? [];
  return {
    event_id: ev.event_id,
    client_ts: toClickHouseDateTime64(ev.client_ts),
    server_ts: toClickHouseDateTime64(ev.server_ts),
    project_id: ev.project_id,
    experiment_id: ev.experiment_id ?? null,
    variation_id: ev.variation_id ?? null,
    visitor_id: ev.visitor_id,
    session_id: ev.session_id,
    event_name: ev.event_name,
    url: ev.url,
    referrer: ev.referrer ?? '',
    country: ev.country || 'XX',
    region: ev.region ?? '',
    region_subdivision: ev.region_subdivision ?? '',
    city: ev.city ?? '',
    device_type: ev.device_type ?? 'unknown',
    browser: ev.browser ?? '',
    os: ev.os ?? '',
    viewport_w: ev.viewport_w ?? 0,
    viewport_h: ev.viewport_h ?? 0,
    tracker_version: ev.tracker_version ?? '',
    is_bot: ev.is_bot,
    in_experiment: ev.in_experiment ?? 0,
    consent_state: ev.consent_state,
    utm_source: ev.utm_source ?? '',
    utm_medium: ev.utm_medium ?? '',
    utm_campaign: ev.utm_campaign ?? '',
    value_native: ev.value_native ?? 0,
    currency: ev.currency ?? '',
    order_id: ev.order_id ?? '',
    items_count: ev.items_count ?? 0,
    props: stringifyProps(ev.props),
    exp_ids: exp.map((t) => t[0]),
    exp_var_ids: exp.map((t) => t[1]),
    exp_session_starts: exp.map((t) => t[2]),
    exp_session_idx: exp.map((t) => t[3] ?? 0),
    goal_id: ev.goal_id ?? 0,
    purchase_type: ev.purchase_type ?? '',
    parent_order_id: ev.parent_order_id ?? '',
    page_type: ev.page_type ?? '',
    cart_id: ev.cart_id ?? '',
    utm_term: ev.utm_term ?? '',
    utm_content: ev.utm_content ?? '',
    screen_w: ev.screen_w ?? 0,
    screen_h: ev.screen_h ?? 0,
    visit_number: ev.visit_number ?? 0,
    entry_referrer: ev.entry_referrer ?? '',
    entry_url: ev.entry_url ?? '',
    entry_utm_source: ev.entry_utm_source ?? '',
    entry_utm_medium: ev.entry_utm_medium ?? '',
    entry_utm_campaign: ev.entry_utm_campaign ?? '',
    entry_utm_term: ev.entry_utm_term ?? '',
    entry_utm_content: ev.entry_utm_content ?? '',
    click_id_type: ev.click_id_type ?? '',
    os_name: ev.os_name ?? '',
    os_version: ev.os_version ?? '',
    browser_name: ev.browser_name ?? '',
    browser_version: ev.browser_version ?? '',
    referrer_domain: ev.referrer_domain ?? '',
    channel: ev.channel ?? '',
  };
}

/**
 * One `event_items` row per item (PRD-006 §1.6, §1.9). `product_id` defaults
 * to `item_id`, `quantity` to 1; prices stay in the event currency.
 */
export function itemRowsFromEvent(ev: EnrichedEvent): EventItemRow[] {
  if (!ev.items || ev.items.length === 0) return [];
  const clientTs = toClickHouseDateTime64(ev.client_ts);
  const expIds = (ev.exp ?? []).map((t) => t[0]);
  return ev.items.map((it) => ({
    event_id: ev.event_id,
    client_ts: clientTs,
    project_id: ev.project_id,
    visitor_id: ev.visitor_id,
    session_id: ev.session_id,
    event_name: ev.event_name,
    exp_ids: expIds,
    order_id: ev.order_id ?? '',
    purchase_type: ev.purchase_type ?? '',
    currency: ev.currency ?? '',
    item_id: it.item_id,
    product_id: it.product_id || it.item_id,
    item_name: it.item_name ?? '',
    item_variant: it.item_variant ?? '',
    item_brand: it.item_brand ?? '',
    item_category: it.item_category ?? '',
    item_category2: it.item_category2 ?? '',
    item_category3: it.item_category3 ?? '',
    price: it.price ?? 0,
    quantity: it.quantity ?? 1,
    discount: it.discount ?? 0,
    item_list_name: it.item_list_name ?? '',
    position: it.index ?? 0,
  }));
}
