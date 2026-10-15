# Reference — ClickHouse schema (full DDL)

Canonical DDL for the `events` table, materialized views, and dictionaries owned by the collector. The migration files in `apps/collector/db/migrations/` should match this exactly.

## 001_create_events.sql

```sql
CREATE TABLE IF NOT EXISTS events
(
    event_id            UUID,
    client_ts           DateTime64(3, 'UTC'),
    server_ts           DateTime64(3, 'UTC') DEFAULT now64(3),
    project_id          UInt64,
    experiment_id       Nullable(UInt64),
    variation_id        Nullable(UInt64),
    visitor_id          String,
    session_id          String,
    event_name          LowCardinality(String),
    url                 String,
    referrer            String DEFAULT '',
    -- geo (CF-derived; never raw IP)
    country             LowCardinality(String) DEFAULT 'XX',
    region              LowCardinality(String) DEFAULT '',
    region_subdivision  LowCardinality(String) DEFAULT '',
    city                LowCardinality(String) DEFAULT '',
    -- device (UA-derived)
    device_type         LowCardinality(String) DEFAULT 'unknown',
    browser             LowCardinality(String) DEFAULT '',
    os                  LowCardinality(String) DEFAULT '',
    viewport_w          UInt16 DEFAULT 0,
    viewport_h          UInt16 DEFAULT 0,
    -- pixel build
    tracker_version     LowCardinality(String) DEFAULT '',
    is_bot              UInt8 DEFAULT 0,
    consent_state       LowCardinality(String) DEFAULT 'unknown',
    -- traffic source (parsed at the pixel from location.search)
    utm_source          LowCardinality(String) DEFAULT '',
    utm_medium          LowCardinality(String) DEFAULT '',
    utm_campaign        LowCardinality(String) DEFAULT '',
    -- revenue (purchase events)
    value_native        Decimal(18, 4) DEFAULT 0,
    currency            LowCardinality(String) DEFAULT '',
    order_id            String DEFAULT '',
    items_count         UInt16 DEFAULT 0,
    -- generic
    props               Map(LowCardinality(String), String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(client_ts)
ORDER BY (project_id, event_name, client_ts)
TTL toDateTime(client_ts) + INTERVAL 13 MONTH
SETTINGS index_granularity = 8192;
```

## 002_create_buffer.sql

```sql
CREATE TABLE IF NOT EXISTS events_buffer AS events
ENGINE = Buffer(
    currentDatabase(),
    events,
    16,            -- num_layers
    5,             -- min_time (s)
    30,            -- max_time (s)
    10000,         -- min_rows
    100000,        -- max_rows
    10000000,      -- min_bytes
    100000000      -- max_bytes
);
```

The consumer INSERTs into `events_buffer`; CH automatically flushes to `events`.

## 003_mv_aov_daily.sql

> **Dropped by migration 019 (PRD-006).** It grouped every purchase under `experiment_id = NULL`; attribution now runs through `exposures` + `exp_ids` and the modeler's `metric_daily` rows. Kept here for history.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_aov_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, currency, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)       AS day,
    project_id,
    experiment_id,
    variation_id,
    currency,
    sum(value_native)       AS revenue,
    count()                 AS orders
FROM events
WHERE event_name = 'purchase' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id, currency;
```

Query pattern:

```sql
SELECT
    variation_id,
    sumMerge(orders)        AS orders,
    sumMerge(revenue)       AS revenue_native,
    revenue_native / orders AS aov
FROM mv_aov_daily
WHERE project_id = ?
  AND experiment_id = ?
  AND day BETWEEN ? AND ?
GROUP BY variation_id, currency;
```

(For multi-currency, convert to `report_currency` via the `fx_rates` dictionary before aggregating.)

## 004_mv_rpv_revenue_daily.sql

> **Dropped by migration 020 (PRD-006).** It grouped every purchase under `experiment_id = NULL`; attribution now runs through `exposures` + `exp_ids` and the modeler's `metric_daily` rows. Kept here for history.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rpv_revenue_daily
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, currency, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts) AS day,
    project_id,
    experiment_id,
    variation_id,
    currency,
    sum(value_native) AS revenue
FROM events
WHERE event_name = 'purchase' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id, currency;
```

## 005_mv_rpv_visitors_daily.sql

> **Dropped by migration 021 (PRD-006).** It grouped every purchase under `experiment_id = NULL`; attribution now runs through `exposures` + `exp_ids` and the modeler's `metric_daily` rows. Kept here for history.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rpv_visitors_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)       AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(visitor_id) AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

RPV computed at query time as `sum(revenue) / uniqExactMerge(visitors)`.

## 006_mv_sessions_daily.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sessions_daily
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)                                  AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(session_id)                         AS sessions,
    uniqExactStateIf(session_id, event_name = 'page_view') AS sessions_with_pageview,
    countStateIf(event_name = 'page_view')             AS page_views
FROM events
WHERE is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

Bounce rate = `1 - sessions_with_pageview / sessions`. Pages-per-session = `page_views / sessions`.

## 007_mv_experiment_summary.sql

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_experiment_summary
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (project_id, experiment_id, variation_id, day)
SETTINGS allow_nullable_key = 1
AS
SELECT
    toDate(client_ts)           AS day,
    project_id,
    experiment_id,
    variation_id,
    uniqExactState(visitor_id)  AS visitors
FROM events
WHERE event_name = 'experiment_view' AND is_bot = 0
GROUP BY day, project_id, experiment_id, variation_id;
```

Used by the daily parity check during pilot (compares CH visitor counts to MySQL `leads` row counts).

## 008_create_fx_dictionary.sql

```sql
CREATE DICTIONARY IF NOT EXISTS fx_rates
(
    date     DateTime,
    from_ccy String,
    to_ccy   String,
    rate     Float64
)
PRIMARY KEY date, from_ccy, to_ccy
SOURCE(HTTP(URL 'http://collector:8000/_internal/fx-rates' FORMAT 'JSONEachRow'))
LIFETIME(86400)
LAYOUT(COMPLEX_KEY_HASHED());
```

Lookup at query time:

```sql
SELECT
    dictGet('fx_rates', 'rate', tuple(toDateTime(toStartOfDay(client_ts)), currency, 'USD')) AS rate_to_usd
FROM events;
```

## 009_create_migrations_tracker.sql

```sql
CREATE TABLE IF NOT EXISTS _migrations
(
    filename    String,
    applied_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY filename;
```

`bun run migrate` reads this table to skip already-applied migrations. Migrations run in filename order (sort alphabetically: `001_*.sql` before `002_*.sql`).

## PRD-006 migrations (013–023)

Ecommerce events + metric modeling (`docs/prds/006-ecommerce-events-and-metric-modeling.md` §2.2, §5.2). One statement per file (runner limitation), all idempotent.

Attribution in one line: an event counts for experiment E iff `has(exp_ids, E)` **and** the visitor is in `exposures` for E (single variation). `exp_ids[i]`, `exp_var_ids[i]`, `exp_session_starts[i]`, `exp_session_idx[i]` are parallel arrays unzipped from the pixel's `exp` tuples.

### 013_events_prd006_columns.sql

New `events` columns (all default empty / 0) + the `idx_exp` bloom index. `os` / `browser` stay for compatibility; `goal_id` carries the crobot goal on `conversion` events.

```sql
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS exp_ids Array(UInt64) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_var_ids Array(UInt64) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_session_starts Array(UInt32) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_session_idx Array(UInt16) DEFAULT [],
    ADD COLUMN IF NOT EXISTS goal_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS purchase_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS parent_order_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS page_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS cart_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS utm_term LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS utm_content LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS screen_w UInt16 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS screen_h UInt16 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS visit_number UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS entry_referrer String DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_url String DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_source LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_medium LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_campaign LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_term LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_content LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS click_id_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS os_name LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS browser_name LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS referrer_domain LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT '',
    ADD INDEX IF NOT EXISTS idx_exp exp_ids TYPE bloom_filter GRANULARITY 4;
```

### 014_buffer_prd006_columns.sql

Same columns on `events_buffer` (no index). Migration 012's lesson: a Buffer created `AS events` does not inherit later columns.

```sql
ALTER TABLE events_buffer
    ADD COLUMN IF NOT EXISTS exp_ids Array(UInt64) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_var_ids Array(UInt64) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_session_starts Array(UInt32) DEFAULT [],
    ADD COLUMN IF NOT EXISTS exp_session_idx Array(UInt16) DEFAULT [],
    ADD COLUMN IF NOT EXISTS goal_id UInt64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS purchase_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS parent_order_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS page_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS cart_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS utm_term LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS utm_content LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS screen_w UInt16 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS screen_h UInt16 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS visit_number UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS entry_referrer String DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_url String DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_source LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_medium LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_campaign LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_term LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS entry_utm_content LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS click_id_type LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS os_name LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS browser_name LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS referrer_domain LowCardinality(String) DEFAULT '',
    ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT '';
```

### 015_events_ttl_pageview_90d.sql

Replaces 011's TTL: in-experiment `page_view` 30 → **90 days**.

```sql
ALTER TABLE events
    MODIFY TTL
        toDateTime(client_ts) + INTERVAL 1 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 0,
        toDateTime(client_ts) + INTERVAL 90 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 1,
        toDateTime(client_ts) + INTERVAL 13 MONTH DELETE;
```

### 016_create_exposures.sql

One row per (project, experiment, visitor). Read with `-Merge`: `argMinMerge(variation_id)`, `uniqExactMerge(variations_seen) = 1` (else excluded, counted in `quality`), `uniqExactMerge(sessions)`, `max(max_session_idx)`, `argMinMerge(<dimension>)`. `visitor_type` (`returning` if max session_idx ≥ 2, also over attributed events) is derived at query time.

```sql
CREATE TABLE IF NOT EXISTS exposures
(
    project_id        UInt64,
    experiment_id     UInt64,
    visitor_id        String,
    first_exposed_at  SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
    variation_id      AggregateFunction(argMin, UInt64, DateTime64(3, 'UTC')),
    variations_seen   AggregateFunction(uniqExact, UInt64),
    sessions          AggregateFunction(uniqExact, UInt32),
    max_session_idx   SimpleAggregateFunction(max, UInt16),
    channel           AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    referrer_domain   AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    utm_source        AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    utm_medium        AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    utm_campaign      AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    utm_term          AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    utm_content       AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    country           AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    region            AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    city              AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    device_type       AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    os_name           AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    browser_name      AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
    screen_resolution AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
ORDER BY (project_id, experiment_id, visitor_id);
```

### 017_mv_exposures.sql

Fed by `experiment_view` rows (scalar `experiment_id` / `variation_id`). **Source columns are qualified `events.x`:** the PRD's unqualified SQL fails on CH 24.10 (code 184) because output aliases like `variation_id` shadow the source column inside other aggregates and in `WHERE`. Not backfilled: only events inserted after the MV exists are counted.

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

### 018_create_event_items.sql

One row per item per commerce event, written by the consumer (task 5.4).

```sql
CREATE TABLE IF NOT EXISTS event_items
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

### 019_drop_mv_aov_daily.sql

```sql
DROP VIEW IF EXISTS mv_aov_daily;
```

### 020_drop_mv_rpv_revenue_daily.sql

```sql
DROP VIEW IF EXISTS mv_rpv_revenue_daily;
```

### 021_drop_mv_rpv_visitors_daily.sql

```sql
DROP VIEW IF EXISTS mv_rpv_visitors_daily;
```

### 022_create_metric_subscriptions.sql

Experiment ids are unique **per project** only (crobot ids), so subscriptions, `metric_daily` reads, Redis run state, locks and query ids are all keyed by `(project_id, experiment_id)` (R3, P4-fix3 `f572432`); both tables already order by `(project_id, experiment_id, …)`, so no schema change was needed.

What crobot wants modeled (sync API §3.1). Latest PUT wins; read with `FINAL`. `status`: running | stopped | deleted.

```sql
CREATE TABLE IF NOT EXISTS metric_subscriptions
(
    project_id      UInt64,
    experiment_id   UInt64,
    status          LowCardinality(String),
    from_date       Date,
    to_date         Nullable(Date),
    report_currency LowCardinality(String),
    metrics         Array(String),
    updated_at      DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (project_id, experiment_id);
```

### 023_create_metric_daily.sql

Modeled daily rows (§2.3), one `run_id` per refresh; readers filter on the last ready `run_id` from Redis. Non-final runs expire after 7 days; the final run after stop (`is_final = 1`) is kept.

```sql
CREATE TABLE IF NOT EXISTS metric_daily
(
    project_id      UInt64,
    experiment_id   UInt64,
    run_id          String,
    computed_at     DateTime64(3, 'UTC'),
    is_final        UInt8 DEFAULT 0,
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

## Operational notes

- **Partitioning by `toYYYYMM(ts)` ⟶ TTL-friendly.** Each month is a discrete partition CH can drop atomically when 13 months old.
- **`ORDER BY (project_id, event_name, ts)`.** Every dashboard query starts with `WHERE project_id = X AND event_name = Y AND ts BETWEEN ...` — this ordering means the primary index hits exactly the right granules.
- **`LowCardinality` everywhere we can.** `event_name`, `country`, `device_type`, etc. — dictionary-encoded, tiny on disk.
- **`Decimal(18, 4)` for revenue** — never floats for money.
- **`Map(LowCardinality(String), String)` for `props`** — keys are LowCardinality (the worker normalizes to a small set), values stored as strings (cast at query time).
- **`SETTINGS allow_nullable_key = 1` on the inner-engine materialized views (006, 007; 003–005 dropped in PRD-006).** Their `ORDER BY` clauses include `experiment_id` and `variation_id`, both `Nullable(UInt64)` (inherited from `events`). ClickHouse 24.x rejects nullable sort keys without this setting. Keeping the columns nullable preserves the semantic distinction between "no experiment context" (NULL) and "experiment with id 0" — never bucket those together. Verified against CH 24.10 in 2026-05-06 smoke test.

## Storage estimate

At 80 M events/month and ~200 bytes / event after compression:

- Per month: ~16 GB
- 13 months retained: ~210 GB total
- Materialized views: <1 GB total

Single-node CH on a modest box (8 cores, 32 GB RAM, NVMe) handles this easily.
