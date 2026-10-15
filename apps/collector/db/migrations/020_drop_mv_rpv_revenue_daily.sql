-- PRD-006 §2.1/§5.2 — drop mv_rpv_revenue_daily (task 5.2): it grouped all purchases under
-- experiment_id = NULL (commerce events carry no single experiment). Replaced
-- by exposures + exp_ids attribution and the modeler's metric_daily rows.
DROP VIEW IF EXISTS mv_rpv_revenue_daily;
