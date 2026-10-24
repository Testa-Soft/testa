# Reference — Event shape

The wire format for events flowing browser → edge → collector → ClickHouse.

## TL;DR — the three shapes

1. **`PixelEvent`** — what the pixel POSTs to the edge worker (`POST /track`).
2. **`EnrichedEvent`** — what the edge worker POSTs to the collector (`POST /_ingest` body items). Adds geo / ASN / UA / bot / consent / ingested_at.
3. **CH `events` row** — the ClickHouse table column-by-column.

All three are kept in lockstep via `packages/shared-types/src/event.ts`. If you change one, change all three plus the migration.

## 1. PixelEvent — wire format from browser → edge

Source of truth: `packages/shared-types/src/event.ts` (PRD-006 additions in P0 `c3e2c04`).

```ts
interface PixelEvent {
  event_id: string;          // UUIDv7, generated client-side per event, persisted in IDB outbox
  event_name: EventName;     // reserved or custom; validated at edge
  client_ts: number;         // Unix ms, client clock at fire time (renamed from `ts`)
  project_id: number;
  experiment_id?: number;    // experiment_view / lead_generated only
  variation_id?: number;
  goal_id?: number;          // conversion events: which configured goal matched
  visitor_id: string;        // _testa_uuid
  session_id: string;        // _testa_sid (browsing session, 30-min sliding)
  url: string;               // full URL; click-id params stripped on the v2 pipeline
  referrer?: string;
  consent_state: ConsentState; // 'granted' | 'denied' | 'unknown'
  tracker_version: string;   // build-time pixel version, e.g. '4.0.3' ('sdk-prd006' from the SDK helpers)
  viewport_w: number; viewport_h: number;   // window.innerWidth/innerHeight, 0 if unavailable
  screen_w: number;   screen_h: number;     // screen.width/height (device resolution), 0 if unavailable
  // PRD-006 experiment sessions (§1.3): active v2 sessions at fire time
  exp: [experiment_id, variation_id, session_start, session_idx][];  // [] outside the v2 pipeline
  in_experiment?: 0 | 1;     // = exp.length > 0 on the v2 pipeline
  visit_number?: number;     // _testa_vn browsing-session count (informational only)
  // current-page UTMs
  utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string; utm_content?: string;
  // session-entry attribution (stamped on experiment_view only, §3.6)
  entry_referrer?: string; entry_url?: string;
  entry_utm_source?: string; entry_utm_medium?: string; entry_utm_campaign?: string;
  entry_utm_term?: string; entry_utm_content?: string;
  click_id_type?: 'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'msclkid' | 'ttclid' | 'li_fat_id'; // type only, never the value
  page_type?: 'home' | 'category' | 'product' | 'search' | 'cart' | 'checkout' | 'thank_you' | 'other';
  cart_id?: string;
  // commerce (§1.5)
  value_native?: number;     // item revenue net of discounts, EXCLUDING tax and shipping
  currency?: string;         // ISO 4217, required with value_native
  order_id?: string;         // purchase: business dedup key; an upsell has its own id
  purchase_type?: 'initial' | 'upsell';  // absent = initial
  parent_order_id?: string;  // required for an upsell
  items_count?: number;      // Σ quantity (edge derives it from items when missing)
  items?: Item[];            // GA4 item shape + product_id, max 50 (§1.6)
  props?: Record<string, string | number | boolean | null>;  // flat; purchase extras (tax, shipping, discount, coupon, payment_type, …)
}
```

Reserved event names: `page_view`, `session_start`, `experiment_view`, `conversion`, `lead_generated` (3.3.3 participation signal — **not** `generate_lead`), `purchase`, `add_to_cart`, `begin_checkout`, `add_shipping_info`, `add_payment_info`, `generate_lead`, `sign_up`, `view_item`, `view_item_list`, `remove_from_cart`, `view_cart`, `_pixel_health`. `checkout_start` is a deprecated alias the edge normalizes to `begin_checkout`. Anything else is custom — it lands as a generic event keyed on `event_name`.

**Sending rules on the PRD-006 pipeline** (projects with `platform_version: "v2"` experiments; PRD §5.3, P1 `c5848e0`): every event carries `exp`; with no active experiment session, events other than `experiment_view` / `_pixel_health` are not sent and are counted in `_pixel_health.props.dropped_no_session`. Projects without v2 experiments are unchanged (`exp: []`, nothing dropped).

### Required-by-event-name

| Event | Required fields |
|---|---|
| `page_view` | url |
| `session_start` | (auto, no extra) |
| `experiment_view` | experiment_id, variation_id (+ entry_* when known) |
| `purchase` | order_id, value_native, currency, items (`purchase_type: upsell` → parent_order_id) |
| `add_to_cart`, `begin_checkout`, `view_item` | items (value_native + currency recommended) |
| `add_payment_info` | props.payment_type |
| `add_shipping_info`, `generate_lead`, `sign_up` | (optional props: lead_type, form_id, method) |
| `conversion` | goal_id |
| `_pixel_health` | props `queued`, `sent`, `dropped`, `retried`, `dropped_no_session`, `oldest_age_ms` |
| custom | event_name + (anything in props) |

The health view measures coverage against `EVENT_PARAM_SPEC` (`packages/shared-types/src/report.ts`).

#### `Item` (§1.6)

`item_id` (required, ≤128 chars), `product_id` (defaults to item_id), `item_name`, `item_variant`, `item_brand`, `item_category`…`item_category5`, `price` (unit price after item discount, ≥ 0), `quantity` (integer 1–9999, default 1), `discount`, `coupon`, `item_list_id`, `item_list_name`, `index`. Strings ≤ 256 chars.

### Idempotency

`event_id` is a UUIDv7 generated at the pixel and persisted in the IndexedDB outbox. The same event may be POSTed multiple times (pixel retry, edge retry); same `event_id` deduplicates at the Redis Stream layer in the collector — see `docs/architecture/02-collector.md` § Idempotency.

## 2. EnrichedEvent — edge → collector

The edge worker takes `PixelEvent`, drops fields you don't want forwarded (raw IP), and adds enrichment. Only the worker is allowed to set the enriched fields (P2 `544a5d6`).

```ts
interface EnrichedEvent extends PixelEvent {
  server_ts: number;         // Unix ms when the worker received the event (renamed from `ingested_at`)
  country: string;           // CF-IPCountry, 2-letter, 'XX' if unknown
  region: string;            // CF region, may be empty
  region_subdivision: string;// CF-derived state/province, e.g. 'California'
  city: string;              // CF-IPCity, e.g. 'San Francisco'
  device_type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
  browser: string;           // ua-parser name, kept for compatibility (e.g. 'Mobile Safari')
  os: string;                // ua-parser name + version, kept for compatibility (e.g. 'Mac OS 10.15.7')
  os_name: string;           // family: iOS, Android, Windows, macOS, Linux, ChromeOS (else the parser's name)
  os_version: string;
  browser_name: string;      // family: Chrome, Safari, Firefox, Edge, Samsung Internet, Opera, IE (else the parser's name)
  browser_version: string;   // major version
  referrer_domain: string;   // host of entry_referrer, www. stripped; '(direct)' if empty / same-site; '' without entry attribution
  channel: string;           // §3.6 rule table on entry attribution (CHANNEL_RULES_VERSION = 1); '' without entry attribution
  is_bot: 0 | 1;             // heuristic hit (e.g. Headless UA, no Accept-Language) → 1, still forwarded
}
```

IP is intentionally **not** in `EnrichedEvent`. It's truncated at the worker (last octet IPv4 / last 80 bits IPv6) and only used for enrichment + denied-consent visitor_id rotation. The collector never sees raw IPs.

## 3. CH `events` row — the warehouse shape

See `docs/reference/clickhouse-schema.md` for the canonical DDL. Mapping:

| EnrichedEvent field | CH column | CH type |
|---|---|---|
| event_id | event_id | UUID |
| client_ts | client_ts | DateTime64(3, 'UTC') |
| server_ts | server_ts | DateTime64(3, 'UTC') |
| project_id | project_id | UInt64 |
| experiment_id | experiment_id | Nullable(UInt64) |
| variation_id | variation_id | Nullable(UInt64) |
| visitor_id | visitor_id | String |
| session_id | session_id | String |
| event_name | event_name | LowCardinality(String) |
| url | url | String |
| referrer | referrer | String (default '') |
| country | country | LowCardinality(String) |
| region | region | LowCardinality(String) |
| region_subdivision | region_subdivision | LowCardinality(String) (default '') |
| city | city | LowCardinality(String) (default '') |
| device_type | device_type | LowCardinality(String) |
| browser | browser | LowCardinality(String) |
| os | os | LowCardinality(String) |
| viewport_w | viewport_w | UInt16 (default 0) |
| viewport_h | viewport_h | UInt16 (default 0) |
| tracker_version | tracker_version | LowCardinality(String) (default '') |
| is_bot | is_bot | UInt8 |
| consent_state | consent_state | LowCardinality(String) |
| utm_source | utm_source | LowCardinality(String) (default '') |
| utm_medium | utm_medium | LowCardinality(String) (default '') |
| utm_campaign | utm_campaign | LowCardinality(String) (default '') |
| value_native | value_native | Decimal(18, 4) (default 0) |
| currency | currency | LowCardinality(String) (default '') |
| order_id | order_id | String (default '') |
| items_count | items_count | UInt16 (default 0) |
| props | props | Map(LowCardinality(String), String) |
| exp[i][0] / [1] / [2] / [3] | exp_ids / exp_var_ids / exp_session_starts / exp_session_idx | Array(UInt64) / Array(UInt64) / Array(UInt32) / Array(UInt16) (parallel arrays) |
| goal_id | goal_id | UInt64 (0 = none) |
| purchase_type, parent_order_id, page_type, cart_id | same | LowCardinality(String) / String (default '') |
| utm_term, utm_content | same | LowCardinality(String) |
| screen_w, screen_h, visit_number | same | UInt16 / UInt16 / UInt32 (default 0) |
| entry_referrer, entry_url | same | String |
| entry_utm_source … entry_utm_content, click_id_type | same | LowCardinality(String) |
| os_name, os_version, browser_name, browser_version, referrer_domain, channel | same | LowCardinality(String) |

PRD-006 columns arrived in migrations 013/014 (`events` + `events_buffer`, plus the `idx_exp` bloom index on `exp_ids`); `in_experiment` in 011/012. Full DDL: `clickhouse-schema.md`.

### `event_items` — one row per item (PRD-006 §2.2)

The consumer writes one `event_items` row per item in the same batch cycle as the event (P2 `6b71520`): `event_id`, `client_ts`, `project_id`, `visitor_id`, `session_id`, `event_name`, `exp_ids`, `order_id`, `purchase_type`, `currency`, `item_id`, `product_id` (defaults to item_id), `item_name`, `item_variant`, `item_brand`, `item_category`…`item_category3`, `price` (default 0 — a missing price is indistinguishable from 0 here), `quantity` (default 1), `discount`, `item_list_name`, `position` (= item `index`).

## Examples

### Pageview

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-1234567890ab",
  "event_name": "page_view",
  "client_ts": 1730902400123,
  "project_id": 42,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/products/widget?utm_source=google",
  "referrer": "https://google.com/",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1920,
  "viewport_h": 1080,
  "utm_source": "google"
}
```

### Experiment view

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "experiment_view",
  "client_ts": 1730902400500,
  "project_id": 42,
  "experiment_id": 17,
  "variation_id": 100,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/products/widget",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1920,
  "viewport_h": 1080
}
```

### Purchase (PRD-006, v2 pipeline)

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "purchase",
  "client_ts": 1760436000000,
  "project_id": 42,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/checkout/success",
  "consent_state": "granted",
  "tracker_version": "4.1.0",
  "viewport_w": 414,
  "viewport_h": 896,
  "screen_w": 414,
  "screen_h": 896,
  "exp": [[1717, 101, 1760433600, 1], [1802, 200, 1760431800, 3]],
  "in_experiment": 1,
  "visit_number": 2,
  "purchase_type": "initial",
  "order_id": "ORD-20261014-0042",
  "value_native": 211.2,
  "currency": "EUR",
  "cart_id": "c_8f2a",
  "items_count": 3,
  "items": [
    { "item_id": "SW-MER-NVY-M", "product_id": "SW-MER", "price": 89, "quantity": 2 },
    { "item_id": "SCF-WL-GRY", "product_id": "SCF-WL", "price": 49, "quantity": 1 }
  ],
  "props": { "tax": 37.5, "shipping": 4.9, "discount": 15.8, "coupon": "AUTUMN10", "payment_type": "card" }
}
```

`value_native` = 2 × 89 + 49 − 15.80 (discount), excluding tax and shipping (PRD-006 §1.7). Built this way by `trackPurchase({...})` on the pixel and the SDKs.

### Custom event

```json
{
  "event_id": "01923a4f-7000-7d9c-bb8f-...",
  "event_name": "newsletter_signup",
  "client_ts": 1730902450000,
  "project_id": 42,
  "visitor_id": "v_abc123",
  "session_id": "s_xyz789",
  "url": "https://store.example.com/",
  "consent_state": "granted",
  "tracker_version": "4.0.3",
  "viewport_w": 1440,
  "viewport_h": 900,
  "props": { "form_id": "footer_newsletter", "source": "blog_post" }
}
```

## Validation

- The pixel uses TS types (no runtime validation; smaller bundle).
- The edge worker validates every entry with Zod (`apps/edge/src/validate.ts`): items (≤ 50, truncated with `props._items_truncated = 1`; item_id 1–128 chars; price ≥ 0; quantity integer 1–9999; strings ≤ 256), `purchase_type` initial/upsell (an upsell needs `parent_order_id`), `exp` tuples of non-negative integers (3-field tuples from older pixels get session_idx 0). **An invalid entry is dropped; the rest of the batch goes through** (the pixel always gets 204). It also normalizes `checkout_start` → `begin_checkout`, derives `items_count`, and defaults `screen_w/h` and `exp`.
- The collector validates on `/_ingest` (envelope + HMAC + replay window; unknown fields pass through).
- Schema mismatches in CH never happen at runtime because the consumer normalizes shapes before INSERT.
