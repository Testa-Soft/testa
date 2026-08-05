-- task 1.8 — page_view in_experiment flag + event_name-scoped differential TTL.
--
-- Adds `in_experiment` (stamped by the pixel, task 3.16) and replaces the blanket
-- 13-month TTL with a three-tier, event_name-scoped rule so the highest-volume /
-- lowest-value rows (non-experiment page_views) are reaped fast while conversions
-- and experiment-associated page_views are kept. Prospective-only: ClickHouse
-- derives TTL from the row's own columns, so a page_view written before the
-- visitor's first exposure stays in_experiment=0 and expires at 1 day (PRD-002
-- "Accepted limitations").
--
-- Single ALTER (ADD COLUMN + MODIFY TTL) so the one-statement migrate runner
-- applies it atomically. IF NOT EXISTS + declarative MODIFY TTL make it
-- idempotent / re-runnable. The Buffer table gets the column in migration 012
-- (a Buffer created `AS events` does NOT inherit later columns, and inserts flow
-- through events_buffer — without 012 the pixel's in_experiment=1 is silently
-- dropped on flush and every page_view reaps at 1 day).
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS in_experiment UInt8 DEFAULT 0 AFTER is_bot,
    MODIFY TTL
        toDateTime(client_ts) + INTERVAL 1 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 0,
        toDateTime(client_ts) + INTERVAL 30 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 1,
        toDateTime(client_ts) + INTERVAL 13 MONTH DELETE;
