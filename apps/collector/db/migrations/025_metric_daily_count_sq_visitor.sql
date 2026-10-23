-- Admin v2 (CONTRACT "Metric keys") — Σ over visitors of n², n = the visitor's
-- per-key count. With `count` (Σ n) and `visitors` it gives the variance of
-- events per visitor, so `count_mode: every` goals get stats (count model).
-- Additive; rows written before this migration read 0 (a refresh rewrites them).
ALTER TABLE metric_daily
    ADD COLUMN IF NOT EXISTS count_sq_visitor Float64 DEFAULT 0 AFTER sum_sq_visitor;
