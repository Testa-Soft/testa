# PRD 006 — Ecommerce event schema + configurable metric modeling (MVP)

**Status:** draft
**Owner:** unassigned
**Date:** 2026-10-14
**Builds on:** PRD-001 (ingest), PRD-002 (page_view funnel), `docs/reference/event-shape.md`

## Goals

1. **Decision metrics for AB tests.** Specialists call tests on this MVP metric
   set:

   | Metric | Numerator | Denominator |
   |---|---|---|
   | **CR** | Purchasing visitors | Visitors |
   | **AOV** | Revenue of initial orders | Initial orders |
   | **Revenue / Visitor** | Revenue | Visitors |
   | **Begin Checkout Rate** | Begin-checkout events | Visitors |
   | **Contact Details Rate** | Contact-details events | Visitors |
   | **Payment Load Rate** | Payment-step events | Visitors |
   | **Lead / Register Rate** | Lead / sign-up events | Visitors |
   | **Upsell Rate** | Initial orders that got ≥1 upsell | Initial orders |
   | **Add to Cart Rate** | Add-to-cart events | Visitors |

   Existing crobot goals (click / page_view / custom) keep working alongside these.
2. **Product-level data for the testa brain (later).** Capture product keys
   (`item_id`, `product_id`, category, brand, price) on commerce events from
   day one, so history exists when the brain is built.
3. **Daily additive rows for crobot.** testa-platform models each subscribed
   experiment into daily rows (first-exposure date × variation × metric key),
   like crobot's `goal_summary`. Crobot pulls them and sums any range. Extras
   and breakdowns are async on-demand queries (Part 3).

## Non-goals (MVP)

- Server-side / webhook order ingestion (Shopify order webhooks etc.): P2.
- Tracking visitors outside an experiment session (see §1.3). For now, events
  outside a session are not sent.
- User identity stitching (`identify` stays a no-op).
- CUPED / variance reduction, sequential testing. We return the stats that make
  them possible later but don't build them now.

---

## Part 1 — Event schema

### 1.1 Naming convention

We adopt the **GA4 ecommerce event names and item shape**, verbatim where
possible. Reasons: it's the de-facto standard, most shops already push it to
`dataLayer`, Shopify/BigCommerce/Woo plugins emit it, and it lets us ship an
auto-capture adapter (§1.8) instead of asking every client to re-instrument.

- Event names: `snake_case`, verb_object (`add_to_cart`, `begin_checkout`).
- Reserved names are owned by Testa; anything else is a **custom event**.
- `checkout_start` (current reserved name, only used in tests) becomes an
  **alias** normalized to `begin_checkout` at the edge.
- ⚠ `lead_generated` already exists in `shared-types` as the 3.3.3 *exposure /
  participation* signal (`createLead`). The marketing "lead" metric uses GA4's
  **`generate_lead`**. The two are unrelated; docs and helpers must not mix
  them up.

### 1.2 Event catalogue

| Event | Fired by | When | Priority | Feeds metric |
|---|---|---|---|---|
| `experiment_view` | auto | Visitor exposed to a variation; **re-fired when a returning visitor's experiment session is re-initialised** (§1.3) | exists | Visitors (denominator) |
| `page_view` | auto | Initial load + each SPA route change (PRD-002) | exists | funnel, URL goals |
| `conversion` | auto | Configured crobot goal matched (click / URL / custom), carries `goal_id` | exists | legacy goals |
| `add_to_cart` | client | Item(s) added to cart | **P0** | Add to Cart Rate |
| `begin_checkout` | client | Checkout started | **P0** | Begin Checkout Rate |
| `add_shipping_info` | client | Contact / shipping details submitted in checkout (GA4) | **P0** | Contact Details Rate, funnel |
| `add_payment_info` | client | Payment step reached / payment info submitted (GA4); carries `payment_type`, `coupon` | **P0** | Payment Load Rate, funnel, payment method share |
| `purchase` | client | Order confirmed, `purchase_type` = `initial` \| `upsell` | **P0** | CR, AOV, RPV, Upsell Rate |
| `generate_lead` | client | Lead form submitted (quote, contact, newsletter…) | **P0** | Lead / Register Rate |
| `sign_up` | client | Account registered | **P0** | Lead / Register Rate |
| `view_item` | client | Product detail page viewed | **P0** (collect) | brain later |
| custom (`track(name, props)`) | client | Anything | **P0** | custom goals |
| `view_item_list`, `remove_from_cart`, `view_cart` | client | List / cart interactions | P1 | brain |

Contact details and payment use **GA4's own events** (decided): `add_shipping_info`
= contact details step, `add_payment_info` = payment step. Shops already
sending GA4 ecommerce need no custom instrumentation. `add_payment_info`
should carry `payment_type` (and `coupon` if known); `purchase` should carry
`coupon` and `payment_type` too.

### 1.3 Experiment sessions (pixel-owned)

The **pixel** owns attribution. The rules:

- **Exposure starts an experiment session** for (visitor, experiment) with a
  **60-minute inactivity timeout**.
- **The timeout is sliding:** every event the pixel sends (page_view, any
  commerce or custom event, conversion) resets it to 60 minutes. A visitor who
  keeps acting for 70 minutes, or 3 hours, stays in the session. It expires
  only after **60 minutes with no events**.
  - The pixel refreshes `lastActivity` in the session cookie at send time, for
    every experiment in `exp`. A shared cookie means activity in one tab keeps
    the session alive in all tabs.
  - Expiry is evaluated as `now − lastActivity > 60 min`, both at send time and
    on page load.
- **When the session expires, the pixel stops tracking**: events are not sent
  (for now).
- **A returning visitor gets a fresh session.** If the pixel still knows their
  bucket (cookie), they go back into the **same variation**, `experiment_view`
  fires again and a new session starts. They are **not** a new visitor: the
  platform counts each (visitor, experiment) once (§2.1). This also covers the
  same tab after 60+ minutes idle: the next experiment evaluation (page load or
  SPA navigation) re-initialises the session.
- Not to be confused with the browsing session cookie `_testa_sid`
  (30-min sliding, `apps/pixel/src/runtime/session.ts`), which still drives
  `session_id`. The two timeouts are independent.
- **Every event sent carries the experiments whose session is active at that
  moment** (new envelope field `exp`, §1.4). That makes attribution exact,
  avoids the platform guessing sessions from timestamps, and handles a visitor
  being in experiment A's session but not B's.

**Where the session state lives: the existing packed `_testa_exp` cookie.**
It already holds `expId.variation.excluded.sessionExp` per experiment
(`packages/experiment-core/src/packed-cookie.ts`), is shared by the pixel and
`@testa-soft/next`, and lives 30 days. We add two fields:

```
expId.variation.excluded.sessionExp.sessionStart.sessionIdx   (~ between experiments)
101.2.0.1760437200.1760433600.2~102.1.0.0.0.1
```

- `sessionExp` (epoch s) = last activity + 3600, rewritten on every sent
  event. That's the sliding timeout. Expired = `now ≥ sessionExp`.
- `sessionIdx` = the visitor's session number in this experiment (1, 2, 3 …), +1 every time a new experiment session starts. Kept for as long as the assignment lives (30 days).
- `sessionStart` (epoch s) = when the current experiment session began. It
  goes into `exp` and identifies the session.
- The parser stays tolerant: 4-field segments (old cookies) parse with
  `sessionStart = 0`, which means "no active session". 5-field segments parse with `sessionIdx = 1` when a session is active, else 0.
- Writes are throttled: the in-memory copy is authoritative, and the cookie is
  written at most every 30 s plus on `pagehide`.
- "Same variation on return" holds while the assignment survives (30 days,
  `ASSIGNMENT_TTL_SEC`).
- The legacy per-experiment `_testa_ses_<expId>` cookie is not used for this.

### 1.3a New vs returning visitors (decided)

A **returning** visitor came back to the experiment and started a new
experiment session (highest `session_idx` ≥ 2). Everyone else is **new**.

- **The label belongs to the visitor, not to an event.** Once a visitor
  returns, **all** of their events count under "returning", including what
  they did in session 1.
- **Visitors are counted once,** on their first-exposure day. Purchases from
  later sessions still count to that day's CR and AOV.
- **Totals never change because of this;** only the new/returning split
  re-sorts when someone comes back.
- **Example, visitor A (Control):**

| When | Event | session_idx | Counted on |
|---|---|---|---|
| Oct 1 | experiment_view, generate_lead | 1 | Oct 1 row |
| Oct 3 | experiment_view, purchase €80 | 2 | Oct 1 row |

| Oct 1 Control rows | Synced Oct 2 | Synced Oct 3 |
|---|---|---|
| total: visitors / leads / purchasers / revenue | 1 / 1 / 0 / €0 | 1 / 1 / 1 / €80 |
| new: visitors / leads | 1 / 1 | 0 / 0 |
| returning: visitors / leads / purchasers / revenue | 0 | 1 / 1 / 1 / €80 |

- **Post-exposure split:** a variation can make people come back, so
  new vs returning is shown but never used to declare a winner. A visitor who
  loses their cookie looks like a new visitor with `session_idx` 1 (same
  limitation as `visitor_id`).
- **`session_idx` in the UI:** per-session views ("session 2 of 3") are a
  front-end concern and read it from events. The data model only needs the
  visitor's highest value.

### 1.4 Common envelope

Every event carries the existing `PixelEvent` envelope (`event_id` UUIDv7,
`event_name`, `client_ts`, `project_id`, `visitor_id`, `session_id`, `url`,
`referrer`, `consent_state`, `tracker_version`, viewport, UTMs) plus the edge
enrichment (geo, device, browser, os, `is_bot`, `server_ts`). No change.

**Additions:**

| Field | Type | Notes |
|---|---|---|
| `exp` | `[experiment_id, variation_id, session_start, session_idx][]` | **Active experiment sessions at fire time** (§1.3). `session_start` = Unix seconds the experiment session began (identifies the session); `session_idx` = 1 for the visitor's first session in that experiment, 2 for the second, and so on. Required on every event the pixel sends. |
| `items` | `Item[]` (max 50) | Required on `add_to_cart`, `begin_checkout`, `purchase`, `view_item`; optional elsewhere. Top-level, not in `props` (props is a flat string map). |
| `page_type` | enum, optional | `home` \| `category` \| `product` \| `search` \| `cart` \| `checkout` \| `thank_you` \| `other`. Hint on `page_view`. |
| `cart_id` | string, optional | Ties ATC → checkout → purchase for the same cart. |
| `utm_term`, `utm_content` | string, optional | Completes the UTM set (only source/medium/campaign are read today). |
| `screen_w`, `screen_h` | int | `screen.width` / `screen.height` (device resolution; `viewport_w/h` already exist). |
| `visit_number` | int | Optional, informational: browser-session count on the site. **Not** used for new vs returning (see §1.3a). |
| `entry_referrer`, `entry_url`, `entry_utm_*`, `click_id_type` | strings | **Session-entry attribution**, stamped on `experiment_view` (see §3.6 note). Captured on the first page of the browser session and kept in sessionStorage. `click_id_type` = which ad click id was present (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`), type only, never the value. |

### 1.5 Commerce fields (top-level)

| Field | Type | On |
|---|---|---|
| `value_native` | decimal | `Σ(price × quantity)` − discounts, **excluding tax and shipping**. Required on `purchase`; recommended on `add_to_cart`, `begin_checkout`. |
| `currency` | ISO 4217 | Required whenever `value_native` is present. |
| `order_id` | string | Required on `purchase`. **Business dedup key** (§2.5). For an upsell, the upsell's *own* id (order id, or order id + line/offer id when the upsell is appended to the original order). |
| `purchase_type` | `initial` \| `upsell` | **New.** On `purchase`; default `initial`. |
| `parent_order_id` | string | **New.** Required when `purchase_type = upsell`, pointing at the initial order. |
| `items_count` | int | Sum of item quantities. Derived by the edge from `items` if omitted. |

Purchase-only extras go in `props` (all optional): `tax`, `shipping`,
`discount`, `coupon`, `payment_type`, `shipping_tier`, `is_first_order`,
`upsell_offer_id`.

`generate_lead` / `sign_up` optional props: `lead_type` (`quote`, `contact`,
`newsletter`…), `method` (`email`, `google`…), `form_id`.

### 1.6 The `Item` object (product keys)

GA4 item shape, plus an explicit parent `product_id` (GA4 lacks it; Shopify,
Woo and most catalogs distinguish product vs variant/SKU).

```ts
interface Item {
  item_id: string;          // REQUIRED. SKU / variant-level key. Stable across sessions.
  product_id?: string;      // Parent product key (groups variants). Defaults to item_id.
  item_name?: string;       // "Merino Crew Sweater"
  item_variant?: string;    // "Navy / M"
  item_brand?: string;
  item_category?: string;   // Top level, e.g. "Apparel"
  item_category2?: string;  // ...down to item_category5 (GA4 hierarchy)
  item_category3?: string;
  item_category4?: string;
  item_category5?: string;
  price?: number;           // Unit price after item-level discount, in event currency
  quantity?: number;        // Integer ≥ 1, default 1
  discount?: number;        // Unit discount amount
  coupon?: string;          // Item-level coupon
  item_list_id?: string;    // Which list it was clicked from (P1)
  item_list_name?: string;
  index?: number;           // Position in that list (P1)
}
```

Edge validation (Zod): `item_id` non-empty ≤ 128 chars; `price ≥ 0`;
`quantity` integer 1–9999; ≤ 50 items/event (truncate and set
`_items_truncated=1` rather than reject); strings ≤ 256 chars;
`purchase_type = upsell` requires `parent_order_id`.

### 1.7 Examples

Envelope fields omitted except `exp`.

**add_to_cart**
```json
{
  "event_name": "add_to_cart", "exp": [[1717, 101, 1760433600, 1]],
  "value_native": 178.00, "currency": "EUR", "cart_id": "c_8f2a",
  "items": [{ "item_id": "SW-MER-NVY-M", "product_id": "SW-MER", "item_name": "Merino Crew Sweater",
              "item_category": "Apparel", "price": 89.00, "quantity": 2 }]
}
```

**begin_checkout → add_shipping_info → add_payment_info**
```json
{ "event_name": "begin_checkout", "exp": [[1717, 101, 1760433600, 1]], "value_native": 227.00, "currency": "EUR",
  "cart_id": "c_8f2a", "items_count": 3, "items": [ ... ] }
{ "event_name": "add_shipping_info", "exp": [[1717, 101, 1760433600, 1]], "cart_id": "c_8f2a" }
{ "event_name": "add_payment_info", "exp": [[1717, 101, 1760433600, 1]], "cart_id": "c_8f2a", "props": { "payment_type": "apple_pay" },
  "value_native": 227.00, "currency": "EUR" }
```

**purchase (initial)**
```json
{
  "event_name": "purchase", "exp": [[1717, 101, 1760433600, 1], [1802, 200, 1760431800, 3]],
  "purchase_type": "initial",
  "order_id": "ORD-20261014-0042",
  "value_native": 211.20, "currency": "EUR", "cart_id": "c_8f2a", "items_count": 3,
  "items": [
    { "item_id": "SW-MER-NVY-M", "product_id": "SW-MER", "price": 89.00, "quantity": 2 },
    { "item_id": "SCF-WL-GRY",   "product_id": "SCF-WL", "price": 49.00, "quantity": 1 }
  ],
  "props": { "tax": "37.50", "shipping": "4.90", "discount": "15.80", "coupon": "AUTUMN10" }
}
```

**purchase (post-purchase upsell)**
```json
{
  "event_name": "purchase", "exp": [[1717, 101, 1760433600, 1]],
  "purchase_type": "upsell",
  "order_id": "ORD-20261014-0042-U1", "parent_order_id": "ORD-20261014-0042",
  "value_native": 24.00, "currency": "EUR", "items_count": 1,
  "items": [{ "item_id": "SOCK-WL-3P", "product_id": "SOCK-WL", "price": 24.00, "quantity": 1 }],
  "props": { "upsell_offer_id": "pp_socks_v2" }
}
```

**generate_lead / sign_up**
```json
{ "event_name": "generate_lead", "exp": [[1717, 101, 1760433600, 1]], "props": { "lead_type": "quote", "form_id": "b2b_quote" } }
{ "event_name": "sign_up",       "exp": [[1717, 101, 1760433600, 1]], "props": { "method": "email" } }
```

**Revenue convention (decided):** `value_native` = item revenue net of
discounts, **excluding tax and shipping** (`2×89 + 49 − 15.80 = 211.20`). This
deliberately differs from GA4's default so shipping thresholds and VAT rates
don't add noise to test results. Tax and shipping are kept in `props`. The
`trackPurchase` helper and the adapters compute `value_native` this way rather
than copying the platform's `value`, which usually includes tax and shipping.

### 1.8 Client APIs and adapters

```ts
// Pixel (window._testa) and @testa-soft/next / react (import { track })
track('add_to_cart', { value_native: 178, currency: 'EUR', items: [...] })
track('size_guide_opened', { product_id: 'SW-MER' })

// Typed helpers (thin wrappers over track):
trackAddToCart(items, { currency, cart_id? })
trackBeginCheckout(items, { currency, value?, cart_id? })
trackShippingInfo({ cart_id? })                       // add_shipping_info
trackPaymentInfo({ payment_type, coupon?, cart_id?, value?, currency? })   // add_payment_info
trackPurchase({ order_id, value, currency, items, purchase_type?, parent_order_id?, tax?, shipping?, coupon? })
                                     // existing positional trackPurchase signature kept for compat
trackLead({ lead_type?, form_id? })
trackSignUp({ method? })
```

- `track` stamps `exp` from the session cookie and **drops the event if no
  experiment session is active** (§1.3).
- `@testa-soft/next`: export `track` + helpers next to the existing
  `pushEvent`. `pushEvent` stays as the goal-matching alias.
- **Auto-capture adapters (P1):**

  | Source | → Testa |
  |---|---|
  | GA4 `dataLayer` `add_to_cart` / `begin_checkout` / `add_shipping_info` / `add_payment_info` / `purchase` / `generate_lead` / `sign_up` | same name, 1:1 |
  | Shopify `product_added_to_cart` | `add_to_cart` |
  | Shopify `checkout_started` | `begin_checkout` |
  | Shopify `checkout_contact_info_submitted` / `checkout_address_info_submitted` | `add_shipping_info` (first one per checkout) |
  | Shopify `payment_info_submitted` | `add_payment_info` |
  | Shopify `checkout_completed` | `purchase` (`initial`) |
  | Shopify post-purchase extension / upsell apps | `purchase` (`upsell`) |

### 1.9 Wire / storage changes

| Layer | Change |
|---|---|
| `packages/shared-types/src/event.ts` | Add `exp`, `Item`, `items?`, `page_type?`, `cart_id?`, `purchase_type?`, `parent_order_id?`, `utm_term?`, `utm_content?`, `screen_w`, `screen_h`, `visit_number`, `entry_referrer?`, `entry_url?`, `entry_utm_source/medium/campaign/term/content?`, `click_id_type?`; `EnrichedEvent` adds `os_name`, `os_version`, `browser_name`, `browser_version`, `referrer_domain`, `channel`; new reserved names; `checkout_start` alias. Full column list: §5.2. |
| Pixel / next | Experiment session in the packed `_testa_exp` cookie (§1.3); re-init on return with same variation; stamp `exp`; drop events outside a session (§5.3). |
| Edge | Zod for the new fields; alias normalization; derive `items_count`. **Enrichment:** split `os` into `os_name` / `os_version` and `browser` into `browser_name` / `browser_version` (today `os` = `"macOS 14.5"`, unusable as a dimension); derive `referrer_domain` and **`channel`** (§3.6) from the entry attribution fields. |
| Collector consumer | Write the event row to `events_buffer` **and** one row per item to `event_items`. |
| `events` table | New columns + `exp_ids` bloom index; full list and migration numbers in §5.2. `in_experiment` stays pixel-sent and equals `notEmpty(exp)`. |

---

## Part 2 — Data modeling

### 2.0 How crobot does it today

| Piece | Where | What it does |
|---|---|---|
| Cron | `app/Console/Kernel.php` → `cache:experiment-statistics` **everyFifteenMinutes** | For each `ACTIVE` experiment: `ClearDuplicates` → `CacheExperiment` |
| Per-goal compute | `CacheExperimentService` → `CacheGoal` → `GoalRepository::getDailyConversions(goal, variation)` | MySQL: `leads` ⟕ `lead_completed_goals`, grouped by `leads.date`, **full history each run** |
| Storage | MySQL `goal_summary (goal_id, variation_id, date, leads, conversions)` upserted | One row per goal × variation × day |
| Read | `GoalResultsResource` → `groups[{identifier, conversions:[{date, leads, conversions}]}]` | Vue (`GoalResults.vue`) **sums the days** → totals |
| Significance | `StatisticsMicroserviceClient::compareGroups` → stats_ms `/api/compare_groups` `{n_control, x_control, n_variation, x_variation}` | Binary only (p-value) |
| Leads | `V2/LeadService::createLeadForExperiment` → `Lead::updateOrCreate(experiment_id, uuid)` | **One lead per visitor per experiment** |

testa-platform replaces the MySQL computation with ClickHouse daily rows
that crobot syncs (Part 3). Crobot keeps the UI, the caching and the stats service.
What we keep from today's model: one lead per visitor per experiment, and a
conversion counts only after exposure.

### 2.1 Attribution

Commerce events can't carry a single `experiment_id` (a visitor can be in N
experiments). The existing `mv_aov_daily` / `mv_rpv_revenue_daily` therefore
group all purchases under `experiment_id = NULL`, and they get **dropped**.

The new model:

- **Visitor (lead)** = one row per (experiment, visitor) in `exposures`,
  taken from the visitor's **first** `experiment_view` → `variation_id`,
  `first_exposed_at`. Returning-visitor sessions re-fire `experiment_view` but
  don't create a new visitor (same as crobot's `updateOrCreate`).
- **`date` = `toDate(first_exposed_at)` in UTC.** Each visitor is in exactly
  one `date` row, so rows are additive.
- **An event counts for experiment E** iff `has(exp_ids, E)`, i.e. the pixel
  says E's session was active when it fired, **and** the visitor is in
  `exposures` for E. No time-window logic on the platform: the pixel owns the
  60-min sliding-timeout rule.
- Conversions from later sessions (a returning visitor buys on day 3) are
  credited to the visitor's first-exposure `date` row, like crobot today.
  So **past rows can still change while the experiment runs**; each refresh
  recomputes the full range.
- Visitors seen in **>1 variation** of E are excluded and counted in `quality`
  (crobot's `ClearDuplicates` equivalent). Events whose stamped variation
  disagrees with the exposure are counted in `quality.variation_mismatch_events`.
- Unit = **visitor** (the randomization unit, so the stats are valid).

### 2.2 New tables

```sql
-- exposures — one row per (project, experiment, visitor). MV on insert. Migrations: §5.2.
CREATE TABLE exposures
(
    project_id        UInt64,
    experiment_id     UInt64,
    visitor_id        String,
    first_exposed_at  SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    variation_id      AggregateFunction(argMin, UInt64, DateTime64(3, 'UTC')),
    variations_seen   AggregateFunction(uniqExact, UInt64),
    sessions          AggregateFunction(uniqExact, UInt32),   -- distinct experiment sessions (session_start values); ≥2 = returning
    -- dimension snapshot at FIRST exposure (pre-treatment → safe to segment by). See §3.6.
    -- Each column: AggregateFunction(argMin, <type>, DateTime64(3, 'UTC'))
    channel, referrer_domain,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    country, region, city,
    device_type, os_name, browser_name, screen_resolution,   -- screen_resolution = 'WxH'
    max_session_idx                                          -- highest session_idx seen; visitor_type = 'returning' if ≥ 2
)
ENGINE = AggregatingMergeTree
ORDER BY (project_id, experiment_id, visitor_id);
-- + mv_exposures: full SELECT in §5.2

-- event_items — one row per item per commerce event (product grain, for the brain later)
CREATE TABLE event_items
(
    event_id        UUID,
    client_ts       DateTime64(3, 'UTC'),
    project_id      UInt64,
    visitor_id      String,
    session_id      String,
    event_name      LowCardinality(String),
    exp_ids         Array(UInt64),
    order_id        String DEFAULT '',
    purchase_type   LowCardinality(String) DEFAULT '',
    currency        LowCardinality(String) DEFAULT '',
    item_id         String,
    product_id      String,
    item_name       String DEFAULT '',
    item_variant    String DEFAULT '',
    item_brand      LowCardinality(String) DEFAULT '',
    item_category   LowCardinality(String) DEFAULT '',
    item_category2  LowCardinality(String) DEFAULT '',
    item_category3  LowCardinality(String) DEFAULT '',
    price           Decimal(18, 4) DEFAULT 0,
    quantity        UInt16 DEFAULT 1,
    discount        Decimal(18, 4) DEFAULT 0,
    item_list_name  String DEFAULT '',
    position        UInt16 DEFAULT 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(client_ts)
ORDER BY (project_id, event_name, product_id, client_ts)
TTL toDateTime(client_ts) + INTERVAL 13 MONTH;
```

Two more tables hold the sync state (Part 3): `metric_subscriptions` (what
crobot wants per experiment) and `metric_daily` (the computed daily rows, one
`run_id` per refresh). DDL: §5.2.

### 2.3 Daily row and metric keys

One additive row per first-exposure date × variation × metric key. **No
derived metric is stored**: crobot sums any date range and divides.

| Field | Meaning |
|---|---|
| `date` | Visitor's first-exposure date (UTC) |
| `variation_id` | Platform variation id |
| `metric_key` | One of the keys below |
| `visitors` | Exposed visitors on that date (same on every key's row) |
| `converted` | Unique visitors who did it at least once |
| `count` | Events, unique orders or units, per key |
| `sum` | Money in the reporting currency, or seconds |
| `sum_sq`, `sum_sq_visitor` | Σ value² per item and per visitor, for significance |

| Key | `converted` | `count` | `sum` |
|---|---|---|---|
| `purchase` | visitors with ≥1 initial order | initial orders | initial revenue |
| `upsell` | visitors with an upsell | initial orders that got ≥1 upsell | upsell revenue |
| `revenue` | purchasing visitors | all orders | all revenue |
| `add_to_cart` | visitors who added | events | cart value |
| `begin_checkout` | visitors who began checkout | events | checkout value |
| `add_shipping_info` | visitors at contact details | events | — |
| `add_payment_info` | visitors at payment | events | — |
| `generate_lead` | visitors with a lead | events | — |
| `sign_up` | visitors who registered | events | — |
| `page_view` | visitors with a page view | page views | — |
| `units` | purchasing visitors | units bought (initial orders) | item revenue |
| `units_added` | visitors who added | units added to cart | — |
| `units_bought_from_cart` | visitors who bought something they carted | units bought that were carted (min per visitor × product) | — |
| `coupon` | visitors who used a coupon | initial orders with a coupon | — |
| `lead` | visitors with `generate_lead` or `sign_up` | events of both | — |
| `lead_purchase` | visitors with a lead (or sign-up) and an initial purchase | same | — |
| `repeat_purchase` | visitors with ≥2 initial orders | same | — |
| `cart_purchase` | visitors with add_to_cart **and** an initial purchase | same | — |
| `checkout_purchase` | visitors with begin_checkout **and** an initial purchase | same | — |
| `session` | visitors with a session | experiment sessions | session seconds |
| `event:<name>` | visitors who fired the custom event | events | — |
| `goal:<id>` | visitors who hit the crobot goal | conversions | — |

**Derived in crobot** (Σ over the chosen dates; never average daily rates):

| Metric | Formula |
|---|---|
| CR | purchase.converted / visitors |
| AOV | purchase.sum / purchase.count |
| Revenue / visitor (= ARPU) | revenue.sum / visitors |
| Step rate, **open funnel** (decided) | later step.converted / earlier step.converted (can exceed 100% when visitors skip steps) |
| Cart abandonment (lower is better) | 1 − cart_purchase.converted / add_to_cart.converted |
| Checkout abandonment | 1 − checkout_purchase.converted / begin_checkout.converted |
| Upsell rate | upsell.count / purchase.count |
| Upsell RPV | upsell.sum / visitors |
| Orders per purchaser | purchase.count / purchase.converted |
| Basket size | units.count / purchase.count |
| Avg item price | units.sum / units.count |
| Buy-to-cart | units_bought_from_cart.count / units_added.count |
| Coupon rate | coupon.count / purchase.count |
| Lead / Register rate | lead.converted / visitors |
| Lead → customer | lead_purchase.converted / lead.converted |
| Repeat purchase rate | repeat_purchase.converted / purchase.converted |
| Pages per visitor | page_view.count / visitors |
| Session duration | session.sum / session.count |

Revenue identity: RPV = CR × orders per purchaser × AOV + upsell RPV (exact).

### 2.4 Computation (one refresh)

1. **Exposed set** from `exposures` for E (single-variation visitors), with
   first-exposure date and dimension values.
2. **Per-visitor values**: `events` filtered to `has(exp_ids, E)`,
   `is_bot = 0`, purchases deduped; joined on `visitor_id`, grouped per visitor
   with `-If` combinators.
3. **Group** by date × variation (× dimension for on-demand queries) and emit
   the rows.

Adding metrics adds columns, not scans. A refresh can take 1–2 minutes on a
large experiment, so it runs on the platform's queue (§3.2), never inside a
request. Reference oracle: `docs/reference/samples/generate.py`
(`summary_values`, `daily_summary`); goldens in
`docs/reference/samples/{f1,demo}/modeled/daily_summary*.json`.

### 2.5 Data-quality rules

| Rule | Why |
|---|---|
| `is_bot = 0` everywhere | Already standard. |
| Purchase dedup by `(project_id, order_id)`, earliest wins | Thank-you reloads create new `event_id`s that Redis dedup can't catch. Upsells have their own `order_id` (§1.5), so they're never deduped against the initial order. |
| Exclude multi-variation visitors; return count | Contamination / `ClearDuplicates` parity. |
| Count events whose stamped variation ≠ exposure variation | Detects pixel cookie / bucketing bugs. |
| Revenue outlier cap for **stats only** (P0): order values and revenue per paying visitor above the experiment's 99th percentile are capped before the Bayesian models (§4.2). Displayed `aov`/`rpv`/`revenue` stay uncapped. | One 50k B2B order shouldn't decide an AOV test. |
| Return `visitors` per variation | Crobot already runs SRM (`calculateSampleRatioMismatch`) on lead counts; it can switch to these. |

### 2.6 Brain (later)

Site-level funnel MVs (`mv_site_funnel_daily`) and product MVs
(`mv_product_daily`, `products`) over `event_items` come after the UI MVP.
Caveat: since the pixel only sends events inside experiment sessions (§1.3),
the brain will only see experiment traffic until "always-on" tracking is
added.

---

## Part 3 — Sync API (crobot ↔ testa-platform)

**Replaces** the old flat `POST …/report` endpoint. Wherever Parts 5–6 still
say "report", read it as daily summary rows (§3.4) or an on-demand query
(§3.5).

**How it works:** crobot subscribes an experiment once. The platform
refreshes that experiment's daily rows on its own queue and stores them.
Crobot pulls the stored rows, which is cheap, and backs off when the
platform says so. A webhook tells crobot early that new rows are ready, but
it's optional.

```
crobot ──PUT subscription─────────► platform
                                     │ scheduler (every 15 min): enqueue running experiments with new events
                                     │ modeler pool (N workers) → ClickHouse metric_daily (one run_id per refresh)
crobot ◄──webhook summary-ready──────┘   (optional)
crobot ──GET daily-summary─────────► platform   → status + rows of the last finished run (milliseconds)
```

Auth on every endpoint: `X-Service-Token: <METRICS_SERVICE_TOKEN>` (task 4.1
middleware). Errors: §5.5.

### 3.1 Subscription

```
PUT    /api/v1/experiments/{experiment_id}/subscription
DELETE /api/v1/experiments/{experiment_id}/subscription?project_id=42      # R3, §3.9
```

```jsonc
{
  "project_id": 42,
  "status": "running",                  // running | stopped
  "from": "2026-10-01",                 // experiment start, UTC
  "to": null,                           // null while running; the stop date once stopped
  "report_currency": "EUR",
  "metrics": ["purchase", "revenue", "add_to_cart", "begin_checkout",
              "add_shipping_info", "add_payment_info", "generate_lead", "upsell",
              "goal:12", "event:size_guide_opened"]      // §2.3 keys
}
```

- **When crobot sends it:** the experiment starts, its goals or core metrics
  change, it stops, or it's archived (`DELETE`). The request is idempotent,
  and the latest one wins.
- **A metric list change** triggers a refresh right away, at high priority.
- **`stopped`** triggers one final run that is kept permanently
  (`is_final = 1`). After that the experiment isn't refreshed again.
- **Response:** `200 {status, next_run_at}` (§3.3 status values).
- **Storage:** ClickHouse `metric_subscriptions` (ReplacingMergeTree on
  `updated_at`). The scheduler reads it.

### 3.2 Refresh (platform-internal)

- **Process:** a new `apps/collector/src/modeler/main.ts`, deployed like the
  consumer.
- **Scheduler** (every 15 min):
  - It enqueues each `running` subscription that has events newer than its
    last run (`max(ingested_at)` for the project, compared to the run's
    `data_through`).
  - It also forces a run when the last finished run is more than 24 h old.
  - A subscription change or a `stopped` status enqueues the experiment
    immediately, at high priority.
- **Queue:**
  - A Redis sorted set (`modeler:queue`), scored by priority, then enqueue
    time.
  - An experiment is in the queue at most once.
  - A per-experiment lock (`SET NX`, TTL 10 min) prevents two runs at the
    same time.
- **Workers:** `MODELER_CONCURRENCY` (default 4) workers, each with a
  ClickHouse `max_execution_time` of 300 s.
- **One run:**
  1. Compute every subscribed metric for the full `[from, to ?? today]`
     range with the §2.4 query.
  2. Insert the rows into `metric_daily` under a new `run_id`.
  3. Mark the run `ready`.

  Rows are never updated in place, so a reader sees either the old run or the
  new one, never half of each.
- **Run state** lives in Redis `modeler:run:{experiment_id}`: `status`,
  `run_id`, `last_ready_run_id`, `computed_at`, `data_through`, `queued_at`,
  `started_at`, `error`, `attempt`.
- **Failure:**
  - Retried 3 times with backoff (30 s, 2 min, 5 min).
  - After that, `status = failed`. The last good run stays readable, and the
    next scheduler tick tries again.
- **Webhook (optional):**
  - Sent when a run becomes `ready`: `POST {CROBOT_WEBHOOK_URL}/api/webhooks/analytics/summary-ready`.
  - Body: `{experiment_id, run_id, computed_at, data_through}`.
  - Headers: `X-Testa-Timestamp` and `X-Testa-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`.
  - Retried 3 times (10 s, 1 min, 5 min), then dropped: crobot's poll
    catches up anyway.
  - A `query-ready` webhook is sent the same way for §3.5 queries.

### 3.3 Status values

Every read returns a `status` and a `retry_after` (seconds; also sent as the
`Retry-After` header). The platform derives `retry_after` from queue depth
and the run's elapsed time, so crobot never guesses.

| `status` | Meaning | Rows in the response | Crobot does |
|---|---|---|---|
| `ready` | Latest run finished; nothing queued | latest run | Upsert, done |
| `queued` | Waiting for a worker | last finished run | Upsert, retry after `retry_after` |
| `running` | A refresh is in progress | last finished run | Upsert, retry after `retry_after` |
| `not_ready` | No run has ever finished (new subscription) | `[]` | Retry after `retry_after`; UI shows "Collecting data" |
| `failed` | Last run failed (after retries) | last finished run | Keep the old rows, show "stale", retry next cycle |

`queued` and `running` happen together with a usable earlier run in almost
every case. Crobot always stores what it gets and only uses the status to
decide whether to ask again.

### 3.4 Daily summary (core rows)

```
GET /api/v1/experiments/{experiment_id}/daily-summary?project_id=42[&since_run_id=r_8f2c]   # project_id: R3, §3.9
```

```jsonc
{
  "status": "running",
  "run_id": "r_8f2c",                     // run the rows come from
  "computed_at": "2026-10-15T09:30:12Z",
  "data_through": "2026-10-15T09:29:58Z", // newest ingested event the run saw
  "next_run_at": "2026-10-15T09:45:00Z",
  "retry_after": 60,
  "from": "2026-10-01", "to": "2026-10-15", "report_currency": "EUR",
  "quality": { "multi_variation_visitors": 12, "variation_mismatch_events": 0 },
  "rows": [
    { "date": "2026-10-01", "variation_id": 100, "metric_key": "purchase",
      "visitors": 96, "converted": 11, "count": 11, "sum": 1309.33,
      "sum_sq": 213004.1, "sum_sq_visitor": 213004.1 }
    // … one row per first-exposure date × variation × subscribed metric_key
  ]
}
```

- **Rows** are the additive daily rows of §2.3: `visitors`, `converted`,
  `count`, `sum`, `sum_sq`, `sum_sq_visitor`. No derived metrics; crobot sums
  any date range and divides.
- **Full range every time.** Old dates change as late conversions come in, so
  crobot **replaces** the experiment's rows with whatever it receives.
- **`since_run_id`:** if it equals the current `run_id`, the response is
  `200` with `"unchanged": true` and no rows, so crobot can skip the upsert.
- **Size:** 14 days × 3 variations × 12 metrics ≈ 500 rows. That's small, so
  there's no paging.
- **Unknown or unsubscribed experiment:** 404 `not_subscribed`.

### 3.5 On-demand queries (extras, breakdowns, sync button)

Use these for anything outside the core subscription, such as abandonment,
payment method share, device or country breakdowns, products, distributions,
or new vs returning.

```
POST /api/v1/experiments/{experiment_id}/queries     → 202 { query_id, status, retry_after }
GET  /api/v1/experiments/{experiment_id}/queries/{query_id}?project_id=42   # R3, §3.9
```

```jsonc
// POST body
{
  "view": "summary",                     // summary | products | distributions | health (§6.5 params go alongside)
  "project_id": 42,                      // R3 (§3.9)
  "from": "2026-10-01", "to": "2026-10-15",
  "metrics": ["purchase", "add_payment_info"],
  "dimension": "device_type",            // optional, one dimension (§3.6); top 10 + "(other)"
  "refresh": false                       // true = the sync button: ignore the cache
}
```

- **`query_id`** = sha256 of the canonical body (minus `refresh`). The same
  request returns the same id. If a result less than 1 h old exists and
  `refresh` is false, the POST returns `200` with `status: "ready"` straight
  away.
- **Priority:** queries go on the same queue as subscription runs, at higher
  priority.
- **Results** are stored in Redis with a 1 h TTL.
- **GET response:** the §3.3 statuses, plus `expired` (410) when the result
  has aged out and must be re-POSTed. When ready it has the same row shape as
  §3.4, with `dimension` and `dimension_value` on each row.
- **Products, distributions and health** (§6.5) aren't separate synchronous
  endpoints any more. They are `view`s of this same endpoint, and their
  response bodies are unchanged; they come back as `result` instead of
  `rows`.

### 3.6 Dimensions (for `dimension` in §3.5)

**Rule: every dimension is a snapshot taken at the visitor's first exposure.**
Values recorded before the variation is shown can't be affected by it, so
comparing variations within a slice stays a fair test. Each visitor is in
exactly one slice per dimension, so slices add up to the total.

Any one of these can be the `dimension` of an on-demand query. It keeps its **top 10 values by visitors**, and the rest are grouped as `"(other)"`.

| Group | `dimension` key | Source | Status |
|---|---|---|---|
| **Traffic & acquisition** | `channel` | Derived at the edge from entry attribution (rules below) | new |
| | `referrer_domain` | Host of `entry_referrer`, `www.` stripped; `(direct)` if empty or same-site | new |
| | `utm_source`, `utm_medium`, `utm_campaign` | new `entry_utm_*` columns (the existing `utm_*` columns stay as current-page values) | new |
| | `utm_term`, `utm_content` | `entry_utm_*` | new |
| **Geographic** | `country` | CF `CF-IPCountry` | exists |
| | `region` | CF region / subdivision | exists |
| | `city` | CF city (high cardinality → top-20 rule matters here) | exists |
| | ~~IP address~~ | Not offered, see below | **no** |
| **Device & technology** | `device_type` | UA → `desktop` / `mobile` / `tablet` | exists |
| | `os_name` | UA → `iOS`, `Android`, `Windows`, `macOS`, `Linux`, `ChromeOS` (family, no version) | **split needed** |
| | `browser_name` | UA → `Chrome`, `Safari`, `Firefox`, `Edge`, `Samsung Internet`… | **split needed** |
| | `screen_resolution` | `screen_w`×`screen_h`, e.g. `390x844` | new |
| **Visitor type** | `visitor_type` | `returning` if the visitor's highest `session_idx` in this experiment is ≥ 2, else `new` (§1.3a). Post-exposure: shown, never used to declare winners. | new |

**Why session-entry attribution.** Today the pixel reads UTMs from the
*current* page URL. A visitor landing on `/?utm_source=google` and seeing the
experiment on page 3 would have empty UTMs on their `experiment_view`, and
`document.referrer` would be our own site. So on the first page of each
browser session, the pixel stores referrer, landing URL, UTMs and click-id type
in sessionStorage and stamps them as `entry_*` on `experiment_view`.

**`channel` rules** (simplified GA4 default channel grouping, evaluated in
order, first match wins; versioned so they can be tuned):

| # | Condition | Channel |
|---|---|---|
| 1 | `click_id_type` ∈ {gclid, gbraid, wbraid, msclkid} or (`utm_medium` ∈ {cpc, ppc, paid, paidsearch} and source is a search engine) | Paid Search |
| 2 | `click_id_type` ∈ {fbclid, ttclid, li_fat_id} or `utm_medium` ∈ {paid_social, paidsocial, social_paid} or (`utm_medium` ∈ {cpc, paid} and source is a social network) | Paid Social |
| 3 | `utm_medium` ∈ {display, banner, cpm} | Display |
| 4 | `utm_medium` ∈ {email, e-mail, newsletter} | Email |
| 5 | `utm_medium` = affiliate | Affiliates |
| 6 | `utm_medium` ∈ {sms} | SMS |
| 7 | any other `utm_*` present | Other Campaign |
| 8 | referrer is a search engine (google., bing., duckduckgo., yahoo., yandex., ecosia., baidu.) | Organic Search |
| 9 | referrer is a social network (facebook., instagram., t.co, x.com, linkedin., pinterest., tiktok., reddit., youtube.) | Organic Social |
| 10 | external referrer | Referral |
| 11 | no referrer / same-site | Direct |

**IP address: not offered.** The platform deliberately never stores IP (it's
truncated at the edge and never reaches the collector; see `event-shape.md`).
That's a GDPR / ePrivacy decision, not a gap. It also doesn't work as a
dimension: almost every IP is unique, so a breakdown would be thousands of
one-visitor slices. Everything useful an IP gives (country, region, city) is
already derived from it at the edge. If a network-level cut is ever needed,
ASN / ISP (`cf.asn`, `cf.asOrganization`) is the safe equivalent.

**Page count in session and session duration: metrics, not dimensions.** They
happen *after* exposure, so the variation itself changes them. Splitting by
them compares groups the variation has already reshaped, which biases the
result. Example: a variation that makes the page faster to scan pushes
visitors into the "1–2 pages" bucket, and CR "within that bucket" stops being
a fair comparison. They're offered as **Pages per visitor** and **Session
duration** metrics (§2.3), which tests compare directly.

### 3.7 Changes on the crobot side

| Area | Change |
|---|---|
| Subscribe | An `ExperimentObserver` (or the start/stop services) sends `PUT …/subscription` on start, a goal/metric change, or stop, and `DELETE` on archive. v2 experiments only. |
| Core pull | The 15-min `cache:experiment-statistics` cron queues one `SyncMetricSummaryJob` per running v2 experiment, spread over the window. The job sends `GET …/daily-summary?since_run_id=…` and replaces the rows in `metric_summary`. On `queued`/`running`/`not_ready` it re-releases itself after `retry_after` (max 3), then waits for the next cycle. |
| Webhook | `POST /api/webhooks/analytics/{event}`, HMAC-verified. `summary-ready` queues `SyncMetricSummaryJob` now; `query-ready` queues `FetchAnalyticsQueryJob`. |
| Extras | Opening an extra block, or pressing sync, sends `POST …/queries` from a job. The UI polls crobot's own status endpoint. Results are cached for 1 h in `analytics_query_results`. |
| UI | Reads only MySQL and never calls the platform during a page load. It shows "Updated X min ago" (`computed_at`), "Collecting data" (`not_ready`) and "Stale" (`failed`). |
| Variation ids | Platform `variation_id` (as in project config); crobot maps it to `identifier`. |

### 3.8 Transition: leads in MySQL vs exposures in ClickHouse

Today `leads` come from MySQL (`/api/leads`). The new endpoint counts
`experiment_view` exposures, so `leads` numbers can differ slightly.
`mv_experiment_summary` already exists for the daily parity check. Rollout:
dual-compute for legacy goal types and compare, then switch each project once
within tolerance (e.g. <1% lead diff). The new ecommerce metrics have no MySQL
equivalent and use the platform from day one.

### 3.9 Contract additions during implementation (shipped)

These were added while building Part 3 (crobot requests R1–R4 in
`tasks/phase-5/logs/CROBOT-REQUESTS.md`, plus platform findings). All are
**additive**; the full reference is `docs/reference/api-endpoints.md`.

| Addition | What | Shipped |
|---|---|---|
| R1 `platform_version` | `ProjectConfig.experiments[].platform_version: 'v1' \| 'v2'` (absent = v1); the config build keeps crobot's value; analytics answer 409 `version_mismatch` for non-v2 | P0 `c3e2c04`, P4-fix1 `b9681b3` |
| R2 `units_upsell` | New daily-row key: `converted` = visitors with an upsell order, `count` = units in upsell orders, `sum` = upsell item revenue; `units` stays initial orders only. Units sold = `units.count + units_upsell.count` | P4-fix2 `b4e856d` |
| R3 project scoping | Experiment ids are unique per project only: **every experiment-scoped call carries `project_id`** — body on `PUT …/subscription` and `POST …/queries`, `?project_id=` on `DELETE …/subscription`, `GET …/daily-summary`, `GET …/queries/:id`. Missing / invalid → 400 `invalid_body` (`field: "project_id"`); an experiment not in that project's config → 404 `experiment_not_found` (before `not_subscribed` / `query_not_found`). Query ids, run state, locks and rate limits are per project; webhook bodies carry `project_id` | P4-fix3 `f572432` |
| R4 `distributions.capped` | With `cap_outliers: true` the distributions result gains `capped: { threshold, by_variation }` (pooled p99 of initial-order values, report currency; count of initial orders above it); absent otherwise | P7-fix1 `6099edb` |
| `quality.unconvertible_orders` | Orders in a currency with no known rate are left out of money sums and counted here; present only when > 0 | P2 `c5d021a` |
| Error codes | `invalid_body` joined `SyncErrorCode` (R3; also the stats endpoint's body errors). `POST /api/v1/stats` adds a route-local `too_large` (> 50 metrics, > 10 variations, body > 256 KiB). Unhandled errors answer 500 `internal_error` | P3 `db54724`, P4-fix3 `f572432` |
| Config alias | Crobot publishes configs by project UUID; the collector also indexes each by its numeric `project_id`, which is what the sync API resolves | P4-fix1 `b9681b3` |
| Webhook body | `event` discriminator in the body: `{ event: 'summary-ready', project_id, experiment_id, run_id, computed_at, data_through }`, `{ event: 'query-ready', project_id, experiment_id, query_id, computed_at }` | P4 `c678dbf`, R3 |

---

## Part 4 — Statistics: Bayesian, by simulation

Significance moves from today's binary p-value service to Bayesian Monte
Carlo for every metric type. **It runs in a stateless platform endpoint,
`POST /api/v1/stats` (decided, task 5.11):** crobot sums the daily rows for
the range it shows and sends those sums; the endpoint returns the outputs
below. No ClickHouse, no state.

### 4.1 Why

Today crobot sends visitors and conversions for two groups to
`stats.testa-soft.tech/api/compare_groups` and calls `probability ≥ 0.95`
significant. That covers conversion rates only, one pair at a time, and the
method lives in neither repo. Simulation covers rates, AOV, RPV and
engagement with one method and any number of variations.

### 4.2 Models

Each variation gets a posterior; we draw N = 100,000 samples per variation,
compare draw by draw, and summarise.

| Model | Metrics | Posterior | Inputs per variation (from summed rows) |
|---|---|---|---|
| `beta` | CR, add-to-cart, steps, lead, `event:*`, `goal:*`, upsell rate, coupon rate, abandonment (direction lower) | Beta(1 + x, 1 + n − x) | n = denominator, x = numerator (e.g. visitors / purchase.converted) |
| `normal` | AOV | Normal on the mean, Student-t posterior, flat prior; p99-capped values (stats only) | n = purchase.count, sum, sumSq (`sum_sq`) |
| `normal` | RPV | as above, per visitor (non-buyers = 0) | n = visitors, sum = revenue.sum, sumSq = `sum_sq_visitor` |
| `normal` | pages per visitor, session duration, basket size, avg item price | as above | count, sum, sum_sq of the key |

**Log-normal: not used (decided).** It quietly down-weights large orders and
needs log sums the rows don't keep. The Normal model counts every order in
full; a big order widens the interval instead.

### 4.3 Outputs

| Field | Meaning |
|---|---|
| `chance_to_beat_control` | share of draws where the variation beats control (flipped for lower-is-better) |
| `chance_to_be_best` | share of draws where it is best of all, control included |
| `lift` | mean of (variation / control − 1) |
| `lift_ci` | credible interval of the lift at `confidence` (default 0.95) |
| `expected_loss` | mean of max(control − variation, 0) / control |
| `insufficient_data` | below 100 visitors per variation or 10 conversions / orders |

Control rows carry `chance_to_be_best` only. **Decision rule (crobot, per
project):** winner = chance to beat control ≥ 95% and expected loss < 0.5%;
loser = ≤ 5%; otherwise collecting.

### 4.4 Simulation details

- 100,000 draws (Monte Carlo error on a 95% probability ≈ ±0.07 points);
  `segment: true` → 10,000 draws. Segment rows never get winner / loser labels.
- Seed from (metric, variation, inputs): identical input → identical output.
- Peeking: results can be read any time; expected loss guards against
  stopping on noise. Sequential guarantees are P2.
- **Golden (F3):** 115 / 4,737 vs 137 / 4,790 vs 109 / 4,702 → variation 101
  chance to beat control ≈ 0.907, best ≈ 0.876; SRM χ² 0.8277, p 0.6611.

### 4.5 API shape

```jsonc
// POST /api/v1/stats
{ "control": 100, "confidence": 0.95,
  "metrics": [
    { "key": "cr", "model": "beta",
      "variations": [ { "variation": 100, "n": 4737, "x": 115 }, { "variation": 101, "n": 4790, "x": 137 } ] },
    { "key": "aov", "model": "normal",
      "variations": [ { "variation": 100, "n": 107, "sum": 9855.6, "sumSq": 1265432.1 },
                      { "variation": 101, "n": 120, "sum": 8839.2, "sumSq": 902211.7 } ] } ] }
// → 200
{ "metrics": { "cr": { "100": { "chance_to_be_best": 0.093 },
                       "101": { "chance_to_beat_control": 0.907, "chance_to_be_best": 0.907, "lift": 0.187,
                                "lift_ci": [-0.076, 0.504], "expected_loss": 0.0058 } },
               "aov": { "…": "…" } } }
```

(AOV inputs illustrative.) Crobot calls it from its sync job for the full
range and from a queued job for custom ranges, and caches the result.

### 4.6 Crobot changes

- Map chance to beat control ≥ 95% + the expected-loss guard to the existing "significant" badge.
- Show chance to beat control and the lift range; chance to be best with 3+ variations.
- Project settings: threshold (95%) and expected-loss limit (0.5%).
- Keep the old stats service for v1 experiments.

---

## Part 5 — Implementation spec (for the coding agent)

Where this part (or Part 6) and an earlier section disagree, **Parts 5–6 win**. Tasks:
`tasks/phase-5/`.

### 5.1 Defaults (decided, don't re-ask)

| Topic | Default |
|---|---|
| Date basis | Visitor's first-exposure date, UTC. Their events count from exposure onward. |
| FX | Each order converted to the reporting currency at the previous UTC day's ECB rate; last known rate if a day is missing (5.19) |
| Purchase dedup | Earliest row per `(project_id, order_id)`, then the `has(exp_ids, E)` filter |
| Purchases without `purchase_type` | treated as `initial` |
| Funnel | open only |
| Top-N | Top 10 by visitors + `(other)` per dimension |
| Outlier cap | p99 of initial-order values, pooled, stats inputs only (and `cap_outliers` queries) |
| Exposure source | `mv_exposures` reads `experiment_view` scalar `experiment_id` / `variation_id` |
| Retention | in-experiment `page_view` raised from 30 to 90 days |
| Control | the first variation in project-config order unless crobot sets `control` |
| Draws | 100k; 10k for segments |
| Min data | 100 visitors per variation and 10 conversions / orders, else `insufficient_data` |
| Winner rule (crobot) | chance to beat control ≥ 95% and expected loss < 0.5% |

### 5.2 ClickHouse migrations (one statement per file, runner limitation)

| File | Statement |
|---|---|
| `013_events_prd006_columns.sql` | `ALTER TABLE events ADD COLUMN IF NOT EXISTS` for every column below, plus `ADD INDEX IF NOT EXISTS idx_exp exp_ids TYPE bloom_filter GRANULARITY 4` |
| `014_buffer_prd006_columns.sql` | Same `ADD COLUMN`s on `events_buffer` (no index) |
| `015_events_ttl_pageview_90d.sql` | `MODIFY TTL`: page_view `in_experiment=0` 1 day, `in_experiment=1` **90 days**, rest 13 months |
| `016_create_exposures.sql` | `exposures` table (§2.2, with types below) |
| `017_mv_exposures.sql` | the MV (below) |
| `018_create_event_items.sql` | `event_items` (§2.2) |
| `019_drop_mv_aov_daily.sql` | `DROP VIEW IF EXISTS mv_aov_daily` |
| `020_drop_mv_rpv_revenue_daily.sql` | `DROP VIEW IF EXISTS mv_rpv_revenue_daily` |
| `021_drop_mv_rpv_visitors_daily.sql` | `DROP VIEW IF EXISTS mv_rpv_visitors_daily` |
| `022_create_metric_subscriptions.sql` | `metric_subscriptions` (below) |
| `023_create_metric_daily.sql` | `metric_daily` (below) |

`mv_sessions_daily` (006) and `mv_experiment_summary` (007) stay (007 is
needed for the MySQL parity check, §3.8).

**New `events` columns** (all `DEFAULT` empty / 0):

```
exp_ids Array(UInt64), exp_var_ids Array(UInt64), exp_session_starts Array(UInt32), exp_session_idx Array(UInt16),
goal_id UInt64,   -- conversion events (goal:<id> metrics); 0 = none
purchase_type LowCardinality(String), parent_order_id String, page_type LowCardinality(String), cart_id String,
utm_term LowCardinality(String), utm_content LowCardinality(String),
screen_w UInt16, screen_h UInt16, visit_number UInt32,
entry_referrer String, entry_url String,
entry_utm_source LowCardinality(String), entry_utm_medium LowCardinality(String), entry_utm_campaign LowCardinality(String),
entry_utm_term LowCardinality(String), entry_utm_content LowCardinality(String),
click_id_type LowCardinality(String),
os_name LowCardinality(String), os_version LowCardinality(String),
browser_name LowCardinality(String), browser_version LowCardinality(String),
referrer_domain LowCardinality(String), channel LowCardinality(String)
```

The existing `os` and `browser` columns stay, for compatibility.

**`exposures` dimension columns**: each is
`AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC'))`.
`max_session_idx` is `SimpleAggregateFunction(max, UInt16)`.
`screen_resolution` and `visitor_type` are derived at query time.

**`mv_exposures`:** (source columns are qualified `events.x`: unqualified, ClickHouse 24.10 resolves names like
`variation_id` to the output alias, an aggregate state, inside other aggregates and in `WHERE`, and rejects the view with
code 184. Shipped as migration `017_mv_exposures.sql`, P0 `80bb9eb`.)

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_exposures TO exposures AS
SELECT
    events.project_id AS project_id,
    assumeNotNull(events.experiment_id)                     AS experiment_id,
    events.visitor_id AS visitor_id,
    min(events.client_ts)                                   AS first_exposed_at,
    argMinState(assumeNotNull(events.variation_id), events.client_ts) AS variation_id,
    uniqExactState(assumeNotNull(events.variation_id))      AS variations_seen,
    uniqExactState(events.exp_session_starts[indexOf(events.exp_ids, assumeNotNull(events.experiment_id))]) AS sessions,
    max(events.exp_session_idx[indexOf(events.exp_ids, assumeNotNull(events.experiment_id))])            AS max_session_idx,
    argMinState(events.channel, events.client_ts)                  AS channel,
    argMinState(events.referrer_domain, events.client_ts)          AS referrer_domain,
    argMinState(events.entry_utm_source, events.client_ts)         AS utm_source,
    argMinState(events.entry_utm_medium, events.client_ts)         AS utm_medium,
    argMinState(events.entry_utm_campaign, events.client_ts)       AS utm_campaign,
    argMinState(events.entry_utm_term, events.client_ts)           AS utm_term,
    argMinState(events.entry_utm_content, events.client_ts)        AS utm_content,
    argMinState(events.country, events.client_ts)                  AS country,
    argMinState(events.region, events.client_ts)                   AS region,
    argMinState(events.city, events.client_ts)                     AS city,
    argMinState(events.device_type, events.client_ts)              AS device_type,
    argMinState(events.os_name, events.client_ts)                  AS os_name,
    argMinState(events.browser_name, events.client_ts)             AS browser_name,
    argMinState(toLowCardinality(concat(toString(events.screen_w), 'x', toString(events.screen_h))), events.client_ts) AS screen_resolution
FROM events
WHERE events.event_name = 'experiment_view' AND events.is_bot = 0 AND events.experiment_id IS NOT NULL AND events.variation_id IS NOT NULL
GROUP BY events.project_id, events.experiment_id, events.visitor_id;
```

`visitor_type` = `if(max(max_session_idx) >= 2, 'returning', 'new')` (the MV only sees `experiment_view`, and a new session can start on a page without one, so the query also takes the max `session_idx` over the visitor's attributed events): **returning = came back to this experiment in a new experiment session** (decided by the user; it can change from new to returning later, and it's a post-exposure split, so it's never used to declare winners).

**Sync tables (Part 3):**

```sql
CREATE TABLE IF NOT EXISTS metric_subscriptions
(
    project_id      UInt64,
    experiment_id   UInt64,
    status          LowCardinality(String),       -- running | stopped | deleted
    from_date       Date,
    to_date         Nullable(Date),
    report_currency LowCardinality(String),
    metrics         Array(String),
    updated_at      DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, experiment_id);

CREATE TABLE IF NOT EXISTS metric_daily
(
    project_id      UInt64,
    experiment_id   UInt64,
    run_id          String,
    computed_at     DateTime64(3, 'UTC'),
    is_final        UInt8 DEFAULT 0,               -- last run after stop; never expires
    date            Date,
    variation_id    UInt64,
    metric_key      LowCardinality(String),
    visitors        UInt64,
    converted       UInt64,
    count           UInt64,
    sum             Float64,
    sum_sq          Float64,
    sum_sq_visitor  Float64
)
ENGINE = MergeTree
ORDER BY (project_id, experiment_id, run_id, date, variation_id, metric_key)
TTL toDateTime(computed_at) + INTERVAL 7 DAY DELETE WHERE is_final = 0;
```

Reads always filter on the `last_ready_run_id` from Redis, so older runs are
ignored until the TTL drops them. The scheduler forces a run at least every
24 h, so a running experiment's latest run never expires.

### 5.3 Pixel rules

- **v2 only:** everything in this section applies to experiments whose config has `platform_version: "v2"`. `exp` lists only v2 experiments. If a visitor has no active v2 session, events are dropped as below (v1 experiments' legacy calls are unaffected).
- **Events sent only inside a session:** every event except `experiment_view`
  (which starts or refreshes a session) and `_pixel_health` is dropped when
  no experiment session is active. Dropped events are counted in
  `_pixel_health.props.dropped_no_session`.
- `page_view` keeps PRD-002's rules (fires at the end of `runExperimentCycle`,
  50/session cap), so it fires after `experiment_view` and lands inside the
  session. `session_start` is dropped like any other event outside a session.
- **Re-init (§6.1):** on any page load or SPA navigation, for each assigned,
  still-active experiment whose session has expired: start a new session
  (`sessionStart = now`). Fire `experiment_view` with the stored variation only
  if the page matches the experiment.
- **`sessionIdx`:** +1 each time a new experiment session starts for that experiment (first session = 1).
- **`exp`:** `[experiment_id, variation_id, sessionStart, sessionIdx]` for every
  experiment with `now < sessionExp`. On send, set `sessionExp = now + 3600`
  for each of them.
- **`visit_number`:** optional, informational only (cookie `_testa_vn`); not used for new vs returning.
  Incremented whenever a new browsing session (`_testa_sid`) is created.
- **Entry attribution:** on the first page of a browsing session, store in
  sessionStorage `{entry_referrer, entry_url, entry_utm_*, click_id_type}`.
  Stamp them on `experiment_view` only.
- **`screen_w/h`:** `screen.width/height`, on every event (cheap).
- **`@testa-soft/next`:** the server-side exposure to crobot `/api/leads`
  stays as is. The client provider fires `experiment_view` through the same
  `track` path as the pixel when `variation_applied` happens, and shares the
  packed cookie session logic from `experiment-core`.

### 5.4 Query semantics not stated elsewhere

- **Session seconds:** per experiment session (visitor, `exp_session_starts[i]`
  for E) = `max(client_ts) − session_start`. A one-event session = 0.
  `session_duration` = Σ seconds / Σ sessions, from `client_ts`. Sessions are counted as distinct
  `exp_session_starts` for E. For stats, each visitor's value is the mean of
  their sessions (Normal model).
- **Paying visitor:** upsell revenue always comes with an initial order (it
  needs `parent_order_id`), so "paying visitor" = visitor with an initial purchase.
- **visitor_type** = `returning` if the max `session_idx` over the visitor's
  `experiment_view` rows and attributed events is ≥ 2 (§1.3a).
- **Purchases with `purchase_type` missing** are treated as `initial`.

### 5.5 Sync API: validation, errors, limits

- **Routes:** Part 3 (§3.1, §3.4, §3.5), mounted under `/api/v1/experiments/*`
  behind the `X-Service-Token` middleware from task 4.1.
- **400** `{ "error": code, "field": … }` for: `unknown_metric`,
  `unknown_dimension`, `unknown_view`, `invalid_range` (`from > to`, or a span
  over 400 days), `invalid_currency`, `invalid_status`.
- **404:**
  - `experiment_not_found` when the experiment isn't in the project's config
    (config store);
  - `not_subscribed` on `GET …/daily-summary` without a subscription;
  - `query_not_found` for an unknown `query_id`.
- **409** `version_mismatch` when the experiment's `platform_version` isn't
  `v2`.
- **410** `expired` for a query result past its 1 h TTL.
- **Empty experiments:** a subscribed experiment with no exposures gets
  **200** `ready` with empty `rows`.
- **No synchronous computation on any read.** GETs only read `metric_daily`
  or Redis (p95 under 200 ms). All computation happens in the modeler (§3.2).
- **Limits:**
  - `MODELER_CONCURRENCY` (default 4) runs per modeler instance;
  - ClickHouse `max_execution_time` of 300 s per run;
  - at most 200 pending on-demand queries per project (**429** `too_many_queries`);
  - POST `…/queries` rate limit of 60/min per project.
- **Stats PRNG:** `xoshiro128**`, seeded from `xxhash32` (already in
  `experiment-core`) of
  `${experimentId}|${metric}|${groupKey}|${variation}|${n}|${x}|${sums}`. Beta
  sampling via two Gamma draws (Marsaglia–Tsang); Normal via Box–Muller.

### 5.6 Test plan (acceptance)

Full version: `docs/prds/006-validation.md` (fixtures F1–F3, flows, `pnpm prd006:validate`).

- **Pixel:** 59 min idle keeps the session, 61 min expires it, 70 min of activity stays in; events dropped outside a session; return fires `experiment_view` with the same variation and `sessionIdx` 2; old cookies parse.
- **Edge:** items validation, upsell needs `parent_order_id`, `checkout_start` alias, OS / browser split, one test per channel rule.
- **Collector:** F1 events → daily rows equal `docs/reference/samples/f1/modeled/daily_summary.json`; summed rows reproduce CR / AOV / RPV; purchase dedup; multi-variation exclusion; FX; top-10 folding; every sync status; `since_run_id`; error codes; views equal their F1 goldens.
- **Stats:** F3 golden values through `POST /api/v1/stats`; same input → same output.
- `pnpm -r typecheck && pnpm -r test && pnpm lint` green.

### 5.7 Repo split

| Repo | Work |
|---|---|
| **testa-platform** (this) | shared-types, migrations, edge, consumer, pixel, `@testa-soft/next`, modeler + sync API, query views, stats endpoint, FX, docs: tasks 5.1–5.19; parallel sessions per `tasks/phase-5/SESSIONS.md` |
| **crobot** | subscription calls, `metric_summary` sync jobs + webhook receiver, on-demand query jobs, results UI (from your wireframes), goal-type mapping to `goal:<id>` / `event:<name>`, project stats settings (95% / 0.5%), keep old stats service for legacy goals. Executed in the crobot repo from `tasks/prd-analytics-v2.md` + the task files `tasks/analytics-v2/C0`–`C10`. |

### 5.8 Superseded

- **Tasks** 4.1–4.8 are cancelled. 4.1's auth middleware is reused (5.18).
- **The synchronous `POST …/report` endpoint** (and products / distributions /
  health endpoints) is replaced by Part 3: modeler + `metric_daily`,
  sync routes, query views, `POST /api/v1/stats`.
- **Types:** `packages/shared-types/src/metric-summary.ts` is replaced by
  `sync.ts` + `report.ts` (5.1). Keep the old file until crobot no longer imports it.
- **Docs** updated in 5.12: `event-shape.md`, `clickhouse-schema.md`,
  `api-endpoints.md`, `architecture/02-collector.md`,
  `diagrams/03-read-path.mmd` (sync flow), `api-endpoints.md` (Part 3 routes). PRD-002 gets a note: page_views are only sent inside
  experiment sessions, and the in-experiment TTL tier is now 90 days.

---

## Part 6 — Analytics V2 dashboard (wireframes) → data contract

Source: "Testa Analytics V2 Wireframes" (two pages: **Goal picker + table**,
which is the launch page, and **Full report** with tabs Summary, Funnel,
Revenue, Products & upsell, Segments, Data health; plus the breakdown picker
and the product-detail panel). **Scope: everything** in both pages.
**Parts 5 and 6 win over earlier sections.**

### 6.1 Decisions from the wireframe review

| Topic | Decision |
|---|---|
| Statistics | **Bayesian (Part 4), mapped onto the wireframe's labels** (§6.4). No separate frequentist engine. |
| Checkout events | GA4: `add_shipping_info` = contact details step, `add_payment_info` = payment step (carries `payment_type`, `coupon`). |
| Upsell | PRD model (`purchase_type` + `parent_order_id`), **not** `item_variant = "upsell"`; `item_variant` stays the real variant (size / colour). |
| User metrics | Identity = `visitor_id` (persistent `_testa_uuid` cookie). Lead → customer, repeat purchase and ARPU are computed per visitor over the report window. |
| ARPU | `revenue ÷ visitors`. With user = visitor it's numerically identical to revenue per visit. Kept as its own key because the wireframe lists it; the UI may hide one. |
| IP address | Not offered (privacy); listed in the wireframe picker but excluded. Everything else in the picker is supported. |
| Top-N | **Top 10 + Other** per dimension (replaces top 20). |
| v1 / v2 experiments | Crobot stamps each experiment `platform_version` (`v1` legacy, `v2` PRD-006); projects migrate to v2 and old experiments stay v1 (crobot PRD §3a). `ProjectConfig.experiments[].platform_version` (missing = `v1`). **PRD-006 tracking applies to v2 experiments only:** sessions, `exp` stamping, `experiment_view` to the edge, and ecommerce attribution. v1 experiments keep only the legacy crobot calls. Analytics endpoints return 409 `version_mismatch` for a v1 experiment. |
| Session re-init | A returning assigned visitor gets a new experiment session on **any** page load (not only matching pages), so returns that go straight to checkout are tracked. `experiment_view` fires only when the page actually matches. Session count = distinct `exp_session_starts`. |

### 6.2 Wireframe metrics → daily rows

Funnel steps in order: `add_to_cart` → `begin_checkout` → `add_shipping_info`
→ `add_payment_info` → `purchase`. **Open funnel only (decided):** a step's
count is everyone who fired it, whether or not they fired earlier steps.

| Wireframe metric | From rows (§2.3) |
|---|---|
| Reached step | `<step>.converted` |
| Cart → checkout, checkout → contact, contact → payment, payment → purchase | next step `.converted` ÷ previous step `.converted` (can exceed 100%; the UI shows it as is) |
| Cart abandonment (lower is better) | 1 − cart_purchase.converted ÷ add_to_cart.converted |
| Checkout abandonment | 1 − checkout_purchase.converted ÷ begin_checkout.converted |
| Basket size, avg item price, units sold, buy-to-cart, coupon rate, orders per purchaser, upsell RPV, lead → customer, repeat purchase | §2.3 formulas |
| ARPU | = revenue per visitor (user = visitor) |

**Funnel-step goals** (sidebar "Funnel steps") use the previous step's
`converted` as their base column instead of visitors.

### 6.3 Extras the dashboard asks for (on-demand queries, §3.5)

| Extra | Query |
|---|---|
| Breakdown / Split by | `view: summary` + `dimension` |
| Payment method share | `view: distributions`, `payment_type` (basis: `add_payment_info` events) |
| Order value histogram, coupon codes, currencies | `view: distributions` (basis: initial orders; 8 pooled quantile bins by default) |
| Payment-method completion ("Apple Pay fell from 80% to 61%") | `view: summary`, `dimension: payment_type` (the visitor's last `add_payment_info.payment_type`), only keys `add_payment_info` + `purchase`; rows carry `post_exposure: true`, never a verdict |
| Products, product detail, upsell items | `view: products` (`product_id`, `purchase_type: upsell`) |
| Data health | `view: health` |
| Outlier capping | `cap_outliers: true` on a summary query; p99 of initial-order values, pooled |

Planning (planned sample, MDE, days remaining), SRM, labels and
recommendations are computed **in crobot** from summed rows. Significance:
crobot sends summed inputs to `POST /api/v1/stats` (task 5.11).

### 6.4 Statistics → wireframe labels

| Wireframe | Computed as |
|---|---|
| "Significant" + blue / "Better" | `chance_to_beat_control ≥ confidence` (default 0.95), **for both directions**: with `direction: 'lower'` the endpoint already flips `chance_to_beat_control` (§4.3; P3 `d7cb1ae`, `db54724`), so "beats control" always means "better" |
| "Significant" + orange / "Worse" | `chance_to_beat_control ≤ 1 − confidence` (both directions, same reason) |
| "Insignificant" / "Inconclusive" | neither |
| "Baseline" | control row |
| "95% CI of uplift" | Bayesian credible interval of relative lift at `confidence` (`lift_ci`) |
| "Early" | Significant **and** `progress < 1` (planned sample not reached) |
| Planned sample, "MDE 15%", "≈ 4 more days" | **Planning, not inference:** the standard two-proportion sample size on the primary metric's current control baseline (α = 1 − confidence two-sided, power 0.8 default). `days_remaining = ceil((planned − min visitors per variation) ÷ (avg daily visitors per variation, last 7 days))`. |
| Sample ratio "Healthy, χ², p" | χ² goodness-of-fit of visitors vs configured weights; `ok = p ≥ 0.001` |
| Status chip "Best: V2" | highest `chance_to_be_best` |

Recommendation text, decision rule, guardrails ("Payment → purchase −4.6 pp"),
"Keep running / Ship / Stop" and "Edit pinned metrics" are **crobot logic**
over these numbers. The platform returns numbers, never verdict text.

### 6.5 Products, distributions, health (query views, §3.5)

These were planned as endpoints; they are now `view`s of `POST …/queries`. The shapes below are the view **params** and **result**; routes and `project_id` come from the queries endpoint.

**`POST /api/v1/experiments/:id/products`**: Products tab, the product rows in
All metrics, and the product-detail panel.

```jsonc
// request
{ "project_id": 42, "from": "…", "to": "…", "report_currency": "EUR", "filters": {},
  "product_id": null,               // set → variant detail for that product
  "purchase_type": "all",           // all | initial | upsell  ("Upsell items accepted" = upsell)
  "search": null, "sort": "revenue_share", "limit": 50 }
// response (list mode)
{ "products": [ { "product_id": "SW-MER", "name": "Merino Crew Sweater", "unit_price": 89.00,
    "by_variation": { "100": { "units_added": 180, "units_purchased": 30, "buy_to_cart": 0.1667, "revenue": 2670.0, "revenue_share": 0.68 },
                      "101": { … , "stats": { "buy_to_cart": { "chance_to_beat_control": 0.41, "lift": -0.06, "lift_ci": [-0.3, 0.2] } } } } } ],
  "total_products": 37 }
// response (detail mode, product_id set)
{ "product_id": "SW-MER", "variants": [ { "item_variant": "Navy / M", "item_id": "SW-MER-NVY-M",
    "share": { "100": 0.38, "101": 0.41 }, "units": { "100": 11, "101": 9 } } ],
  "kpis": { "units_purchased": {…}, "buy_to_cart": {…}, "revenue_share": {…} } }
```

- **Product-detail tree (wireframe "Products × variants"):** list mode always
  nests variants. Each product row has `units`, **`units_share`** (units ÷ all
  units in that variation), `revenue_share` and `buy_to_cart`, plus `variants[]`.
  Each variant has `units`, `share_of_product` (variant popularity) and
  `revenue_share`.
- **Default list:** sort by control revenue, `limit: 8` plus `offset` for
  "Show 10 more". Everything beyond the limit is aggregated into one
  `"Other products"` row with no variants.
- **Low sample:** `low_sample: true` on a variant when control units < 15.
- Units come from `event_items` with `has(exp_ids, E)`, attributed to the
  visitor's exposure variation.
- Variant share = units of that `item_variant` (fallback `item_id`) ÷ units
  purchased of the product.
- Top 10 variants + "Other".

**`POST /api/v1/experiments/:id/distributions`**: Revenue tab and payment
method share.

```jsonc
// request: { project_id, from, to, report_currency, filters, "distributions": ["payment_type","coupon","currency","order_value"],
//            "order_value_bins": [0, 25, 50, 75, 100, 150, 200] }   // optional; default = 8 quantile bins of pooled values
// response: per distribution, per variation: [{ "value": "apple_pay", "count": 41, "share": 0.11 }, …]
//   payment_type basis = add_payment_info events; coupon / currency / order_value basis = initial orders.
//   coupon: top 10 codes + "Other codes (n)" + "No coupon"; order_value bins in report_currency (respects cap_outliers).
```

**`GET /api/v1/experiments/:id/health?project_id=&from=&to=`**: Data health
tab and the Summary "Tracking: 2 warnings" card.

```jsonc
{ "events": [ { "event_name": "purchase", "status": "ok|warning|missing", "last_event_at": "…",
                "events": { "100": 412, "101": 455 }, "visitors": { "100": 396, "101": 452 },
                "params": [ { "param": "order_id", "required": true, "present_pct": 1.0 },
                            { "param": "items[].price", "required": true, "present_pct": 0.97 } ] } ],
  "metrics": [ { "key": "payment_load_rate", "availability": "full|limited|unavailable", "reason": "…" } ],
  "srm": { … as §6.3 … },
  "summary": { "events_receiving": 7, "events_expected": 7, "param_warnings": 2, "metrics_full": 21, "metrics_limited": 4 } }
```

- **Required parameters per event:** `EVENT_PARAM_SPEC` in
  `packages/shared-types`. purchase: order_id, value_native, currency, items,
  items[].item_id, items[].price, items[].quantity, purchase_type.
  add_to_cart: items, items[].item_id, items[].price. add_payment_info:
  payment_type. begin_checkout / add_shipping_info: none.
- **Status thresholds:** `missing` = no events in the window; `warning` = any
  required parameter below 95% present; else `ok`.
- **Metric availability** is derived from the events and parameters each
  metric needs.

### 6.6 Screen → data map

| Screen | Data |
|---|---|
| Header | crobot config + planning from summed rows |
| Goal sidebar + results table | summed `metric_summary` rows, all goal keys + stats |
| Trend chart | `metric_summary` per date (cumulative = running sums in crobot) |
| All metrics table | summed rows; payment method share and product rows via queries |
| Split by | summary query with `dimension` |
| Product detail | products query with `product_id` |
| Summary tab | summed rows (primary + pinned, planning, SRM) + health summary |
| Funnel tab | summed rows (steps, abandonment) + payment_type summary query |
| Revenue tab | summed rows + distributions query |
| Products & upsell tab | products query + summed rows |
| Segments tab | summary query with one dimension + payment_type distribution |
| Data health tab | health query |

---

## Phased delivery

| Phase | Scope |
|---|---|
| P0 — collect | Pixel / next experiment sessions (`exp` stamping, `session_idx`, drop outside a session); entry attribution; edge OS / browser split, `referrer_domain`, `channel`; shared types; Zod; new `events` columns + `event_items`; `track` + typed helpers |
| P0 — model | `exposures` MV; modeler + `metric_daily`; sync API; query views; stats endpoint; FX previous-day + backfill; drop `mv_aov_daily` / `mv_rpv_*`. Crobot: `metric_summary` sync, extras, V2 UI. |
| P1 | GA4 `dataLayer` + Shopify adapters; purchase capture check (alert above 10% missing); closed funnel if asked for |
| Later — brain | Site funnel + product MVs; always-on tracking outside experiment sessions |
| P2 | Server-side order ingestion; CUPED; sequential testing |

## Decisions

1. **Revenue** = item revenue net of discounts, excluding tax and shipping.
2. **Daily additive rows, no stored derived metrics.** One row per first-exposure date × variation × metric key; crobot sums any range and divides.
3. **All dates are UTC.**
4. **The pixel owns the experiment session**: 60-minute sliding timeout; events outside a session are not sent; the platform attributes purely on the `exp` stamp.
5. **Returning visitors** get a new session in the same variation and are not counted again; conversions go to their first-exposure date.
6. **Acceptable purchase undercount:** up to 10%.
7. **The crobot UI is the MVP**, breakdowns included; the brain comes later.
8. **Dimensions** are snapshotted at first exposure; acquisition fields come from the session entry (§3.6).
9. **No IP dimension.**
10. **Page count and session duration are metrics**, not dimensions.
11. **Significance is Bayesian by simulation**, served by a stateless platform endpoint `POST /api/v1/stats` fed summed rows: Beta for rates, Normal on the mean for AOV / RPV / engagement (no log-normal). Winner = ≥ 95% chance to beat control and < 0.5% expected loss; segment rows never declare winners.
12. **V2 dashboard is in scope in full**: GA4 checkout events, upsell via `purchase_type`, visitor-based user metrics, top 10 + Other.
13. **Bayesian results map onto the UI labels** (§6.4); planned sample / MDE / days remaining are planning only.
14. **Sync is pull-with-status, platform-scheduled** (Part 3). The webhook is optional; extras are async queries cached 1 h.
15. **New vs returning = the pixel's `session_idx`** (§1.3a); per visitor, all their events follow it.
16. **Currency:** per order, previous day's rate, into the project's reporting currency, then sum.
17. **v1 / v2** at project and experiment level; v1 experiments never touch the new pipeline.
18. **Open funnel only** for the MVP; abandonment uses `cart_purchase` / `checkout_purchase` so it stays between 0 and 100%.

## Open questions

- [ ] **Core metric list:** confirm which keys every subscription carries vs which are extras (default: all §2.3 keys except `page_view` and `session`, which are extras).
- [ ] **New vs returning:** on-demand only (default) or core?
- [ ] **Reporting currency:** per project (default) or per experiment?
- [ ] **Trend chart:** a point per first-exposure date (cohort) is what rows give; confirm that reading.
- [ ] **Priors:** flat now; informed by project history later?

**Raised during implementation (human queue, not resolved here):**

- [ ] **Health event counts vs golden:** the health view counts raw attributed events, duplicates included (as 006-validation F1 states: "control 2 (v1 incl. duplicate)"), but the oracle `generate.py health()` counts the purchase-deduped list, so `f1/modeled/health.json` shows control purchase events **1** where the implementation returns **2** (demo purchase counts are short by the duplicates too). The health test patches the golden's purchase entry; goldens and 006-validation are untouched. Which is intended — fix the oracle + regenerate, or count deduped events?
- [ ] **Page rules for variation apply:** the 4.0 pixel runtime does not evaluate experiment page rules (`rules[]`) when *applying* variations — every active experiment applies on every page. PRD-006 only needs the v2 `experiment_view` gated on the page rule, which is what shipped (P1 `c5848e0`). Should variation application be page-gated too?
- [ ] **`_pixel_health` emission:** the pixel counts delivery health but never sends the periodic `_pixel_health` event; only the PRD-006 `dropped_no_session` report (once per page on pagehide, v2 only, P1 `116d676`) is sent. Build the hourly emit?
- [ ] **Cross-origin `/track`:** pagehide events are lost when `/track` is on another origin (browsers refuse a cross-origin JSON `sendBeacon`). Documented as "serve `/track` same-origin"; switch the beacon body to a CORS-safelisted type instead?
