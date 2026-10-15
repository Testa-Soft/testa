-- PRD-006 §5.2 — new `events` columns + `exp_ids` bloom index (task 5.2).
--
-- exp_* are the pixel's active experiment sessions at fire time, unzipped from
-- the wire `exp` tuples (parallel arrays: exp_ids[i] ↔ exp_var_ids[i] …). An
-- event counts for experiment E iff has(exp_ids, E); idx_exp makes that cheap.
-- The existing `os` / `browser` columns stay for compatibility.
--
-- One ALTER (the migrate runner executes one statement per file); IF NOT EXISTS
-- makes it re-runnable. The Buffer table gets the same columns in 014.
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
