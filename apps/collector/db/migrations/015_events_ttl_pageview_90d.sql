-- PRD-006 §5.1/§5.2 — in-experiment page_view retention raised 30 → 90 days (task 5.2).
--
-- Replaces 011's TTL wholesale (MODIFY TTL is declarative, so re-running is a
-- no-op). Tiers: non-experiment page_view 1 day, in-experiment page_view
-- 90 days, everything else 13 months.
ALTER TABLE events
    MODIFY TTL
        toDateTime(client_ts) + INTERVAL 1 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 0,
        toDateTime(client_ts) + INTERVAL 90 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 1,
        toDateTime(client_ts) + INTERVAL 13 MONTH DELETE;
