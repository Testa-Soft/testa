-- PRD-006 §2.2 — one row per item per commerce event (product grain) (task 5.2).
--
-- Written by the consumer next to the events row (task 5.4). Attribution works
-- like events: has(exp_ids, E). Feeds the products view now, the brain later.
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
