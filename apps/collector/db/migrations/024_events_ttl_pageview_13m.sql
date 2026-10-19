-- Admin v2 (CONTRACT "Settled product decisions" #8) — in-experiment page_view
-- retention raised to 13 months so page-view goals (`page:<match>:<value>`
-- metric keys) keep their full history; goals are views over stored data.
--
-- Replaces 015's TTL wholesale (MODIFY TTL is declarative, so re-running is a
-- no-op). Tiers: non-experiment page_view 1 day (unchanged), in-experiment
-- page_view 13 months, everything else 13 months. The in-experiment tier is
-- kept explicit (not folded into the catch-all) so a later change to either
-- horizon stays a one-line edit.
--
-- Buffer: events_buffer needs no change. TTL is a MergeTree property — the
-- Buffer engine has none and evaluates nothing; rows get their TTL when they
-- flush into `events`. No columns change here, so 011/012's gotcha (a Buffer
-- created `AS events` doesn't inherit later columns) doesn't apply.
ALTER TABLE events
    MODIFY TTL
        toDateTime(client_ts) + INTERVAL 1 DAY DELETE
            WHERE event_name = 'page_view' AND in_experiment = 0,
        toDateTime(client_ts) + INTERVAL 13 MONTH DELETE
            WHERE event_name = 'page_view' AND in_experiment = 1,
        toDateTime(client_ts) + INTERVAL 13 MONTH DELETE;
