-- PRD-006 §3.1/§5.2 — what crobot wants modeled per experiment (task 5.2).
--
-- Latest PUT wins (ReplacingMergeTree on updated_at); read with FINAL.
-- status: running | stopped | deleted. The modeler's scheduler reads this.
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
