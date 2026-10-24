-- PRD-006 §5.2 — populate `exposures` from experiment_view rows (task 5.2).
--
-- Exposure source = the scalar experiment_id / variation_id on experiment_view
-- (§5.1). Session fields come from the exp_* arrays at the experiment's index.
-- utm_* snapshot the session-ENTRY UTMs (entry_utm_*), not the current page's.
-- Source columns are qualified (`events.x`) because several output aliases
-- reuse a source column name (variation_id, utm_*), and ClickHouse would
-- otherwise resolve them to the alias (an aggregate state) inside other
-- expressions and in WHERE (PRD §5.2's unqualified SQL fails with code 184).
-- Fires on inserts into `events` (incl. events_buffer flushes); not backfilled.
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
