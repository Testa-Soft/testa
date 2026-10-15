-- PRD-006 §3.2/§5.2 — modeled daily rows, one run_id per refresh (task 5.2).
--
-- Rows are never updated in place: a refresh inserts a new run_id and readers
-- filter on the last ready run_id (Redis), so they see one whole run. Non-final
-- runs expire after 7 days; the final run after stop (is_final = 1) is kept.
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
