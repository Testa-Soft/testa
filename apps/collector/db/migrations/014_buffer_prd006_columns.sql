-- PRD-006 §5.2 — mirror 013's columns onto the Buffer table (task 5.2).
--
-- Migration 012's lesson: events_buffer was created `AS events` and does NOT
-- inherit columns added later. The consumer inserts into events_buffer, so
-- without these the new fields would be dropped on flush. No index: Buffer
-- tables don't support them. ALTER (not DROP+CREATE) keeps buffered rows.
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
