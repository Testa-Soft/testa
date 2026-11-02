# Orchestrator handoff — PRD-006 + Analytics V2 (2026-10-16 09:15; steps 1–6 DONE 10:40, see BOARD.md tail)

Read this first, then `BOARD.md` (decision log at the bottom), `ORCHESTRATOR.md`, `PACKAGES.md`.
Nothing is pushed. Integration branches are **local only**: `feat/prd006` (testa-platform), `feat/analytics-v2` (crobot).

## Why the previous orchestrator stopped
Docker Desktop crashed ~02:00 on 2026-10-16. The orchestrator session (`testa-platform-9d`) exited with it.
The machine did NOT reboot. Worker sessions are alive but idle. **Docker must be restarted before anything live runs** (`open -a Docker`, then wait for `docker ps`).
After restart, verify containers: `tp-clickhouse` (:8123; "unhealthy" is a cosmetic IPv6 healthcheck), `tp-redis` (:6380), `crb-php`, `crb-mysql`, `crb-nginx`, `crb-redis`. Leave the old `tp-collector` (:8090) alone.

## Worktrees (where to do things)
| Purpose | Path | Branch |
|---|---|---|
| platform integration (merge + gates + run harnesses here) | `~/projects/testa-platform/.worktrees/int` | `feat/prd006` |
| crobot integration (merge here) | `~/projects/crobot/.worktrees/int` | `feat/analytics-v2` |
| crobot e2e app for X0 (`--crobot-dir`) | `~/projects/crobot/.worktrees/x0` | `feat/analytics-v2-x0` (merge feat/analytics-v2 into it before each X0 run) |
| crobot C-INT | `~/projects/crobot/.worktrees/cint` | `feat/analytics-v2-cint` |
Old package worktrees under both `.worktrees/` can be removed once merged.

## State
### testa-platform `feat/prd006` @ 6190619 — everything merged except P6 part B
Merged: P0, P1, P2, P3, P4 (+fix1 config alias by numeric project_id + platform_version mapping, fix2 `units_upsell`, fix3 R3 project scoping), P5 harness, P7 (+fix1 R4 `distributions.capped`), P8, X0 harness, P6 part A (docs), P6-tests (no FLUSHDB in tests), integration fixes.
Last gate on int: typecheck 0, lint clean, collector 292/0 live (CH `prd006_int`, Redis :6380), all packages green.
**Not merged:** `feat/prd006-p6b` = fd4969b (V13 half-even rounding fix) + 0d72b1b (`docs/prds/006-validation-report.md`, tasks/README, RUN_LOG).
Full validation (`PRD006_CLICKHOUSE_DATABASE=prd006_p6 pnpm prd006:validate --port 8093`, Redis DB 12): **15/16 flows pass** (55/57 checks). V12 FAIL = spec tolerance (human). **V10 perf unverified** (one reading ~299.x ms p95 for stats 20×3 vs PRD <300 ms, then Docker died).

### crobot `feat/analytics-v2` @ 9e573fb — CA, CB(+fix1 identifiers, fix2 R3, fix3 explicit subscribe), CC, CD, X0 hooks merged
**Not merged:** `feat/analytics-v2-cint` @ b606694 — C-INT done: dead code removed, settings metric ids validated, PlatformIdMap partial remap, cron syncs stopped v2 experiments until final run, task SHAs, mock-mode PRD §9 acceptance (7 tests, all §9 numbers). Gate before its last merge: 0 new failures vs baseline. **Post-merge gate not re-run** (Docker died).
Crobot gate = no regression vs `tasks/orchestration/crobot-baseline.md` (61 genuine master failures; 68 with stock `.env`; phpstan 0 new). Tests use MySQL `test_crobot_<pkg>` (NOT SQLite). Run inside `crb-php`: `docker exec -u www-data -w /var/www/html/.worktrees/<pkg> crb-php bash -lc '...'` with `-e DB_DATABASE=test_crobot_<pkg>` and the CRO_AUDIT_* recipe from the baseline file.

### Live cross-repo E2E (X0 harness, `pnpm e2e:cross`)
Last full run (run 6, before CB-fix3): **42 pass · 12 fail · 1 pending**. CB-fix3 then made `--only sync` **17 pass · 0 fail** (extras pending CD, since merged). The UI layer has never run live yet.
Run (from platform int): `pnpm e2e:cross --platform-dir ~/projects/testa-platform/.worktrees/int --crobot-dir ~/projects/crobot/.worktrees/x0` (add `--strict` for X1). Ports: collector :8091, edge :8792, crobot e2e app :8188, CH `prd006_x0`, Redis DB 13. Report: `.worktrees/int/node_modules/.cache/e2e-cross/report.md`. Only ONE X0 run at a time machine-wide.
Redis DBs: collector tests use 7 (REDIS_TEST_DB), prd006:validate 12, X0 13.

## Remaining steps (in order)
1. Restart Docker; wait for the machine to calm down (PhpStorm reindex spiked load to ~200).
2. Merge `feat/prd006-p6b` into `feat/prd006` (int); gate (typecheck, lint, `CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_DATABASE=prd006_int REDIS_URL=redis://localhost:6380 bun test --cwd apps/collector`, `pnpm -r test`).
3. Re-run C-INT gate in `crobot/.worktrees/cint`; merge `feat/analytics-v2-cint` into `feat/analytics-v2`.
4. V10 perf ×3 on a QUIET machine: `PRD006_PERF=1 pnpm prd006:validate --port 8093 --only V10 --report <tmp>`; record p95 + load; update the V10 section of `docs/prds/006-validation-report.md`.
5. **X1 final acceptance:** merge feat/analytics-v2 into `crobot/.worktrees/x0`, run full `pnpm e2e:cross --strict` incl. UI (Playwright screenshots of every crobot §9 screen). Fix anything red with focused follow-ups.
6. Final report to the human (publish), then decide with the human on merging to main/master and pushing.

## Sessions (all idle, alive)
| Session | Name | Last work | Notes |
|---|---|---|---|
| ba91ec56 | `unexpected-sphynx-88` | P0, P4, P2, P1, P4-fix2, P7-fix1, P6 A/B | platform; superset worktree; knows the whole platform |
| 9c4ef530 | `boulder-polo-3e` | P3, P8, P7, P5 | platform; standby |
| c25b049f | `crimson-bar-dd` | CA, CD, C-INT | crobot; works in `crobot/.worktrees/*` |
| 37e5f314 | (not messageable) | — | crobot main checkout; never used |
| 5ea23041 | `testa-platform-de`? (not confirmed) | — | never used |
Session files: `tasks/orchestration/sessions/<id>.md` (assignments + reports). Messages to workers are held for approval when permission modes differ.
Rules from the human: max ~4 active workers / 2 subagents; don't overload the machine; DoD = live cross-container tests, not mocks; workers kill only their own processes by PID.

## Human queue (decisions needed)
1. V12: RPV identity tolerance ±1e-6 impossible on cent-rounded rows (Δ up to 3.9e-6) — suggested ±0.01 × rows/visitors.
2. Health golden: `generate.py health()` oracle bug (dead `raw=[]`, counts deduped) → golden F1 control purchase = 1 but spec/validation doc say 2. Fix oracle + regenerate health goldens?
3. Pixel: variation **apply** is not gated by experiment page rules (pre-existing 4.0 gap); only v2 `experiment_view` is. Gate apply too?
4. `_pixel_health` emit cadence (P1 emits on pagehide when drops occurred).
5. `coupon_rate` direction (assumed higher-is-better).
6. Analytics settings bounds: confidence 0.8–0.99, expected loss (0, 0.1], MDE (0, 1).
7. Crobot test DB policy: docs say SQLite, reality is shared MySQL (per-package DBs used); `phpstan-baseline.neon` not wired; 61 tests fail on master.
8. Stats endpoint has no total draw budget (50×10×100k ≈ 5 s sync CPU on the collector).
9. PRD-006 status line still "draft".
10. Release notes: a 1.5.0 Next middleware rewriting the cookie drops session fields 5–6 → v2 on Next needs the new SDK; cross-origin pixel `apiUrl` loses pagehide events (sendBeacon).
