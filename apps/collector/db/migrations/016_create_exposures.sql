-- PRD-006 §2.2/§5.2 — one row per (project, experiment, visitor), fed by mv_exposures (task 5.2).
--
-- Visitor = first experiment_view: variation_id / first_exposed_at come from it,
-- and the dimension columns are a snapshot at first exposure (pre-treatment, so
-- safe to segment by). variations_seen > 1 → excluded as contaminated.
-- sessions = distinct experiment-session starts; max_session_idx ≥ 2 → returning.
-- screen_resolution is 'WxH'; visitor_type is derived at query time.
-- Read with -Merge combinators (uniqExactMerge(variations_seen), argMinMerge(…)).
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
