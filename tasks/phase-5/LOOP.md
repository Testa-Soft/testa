# Loop rules (every work package, both repos)

Work runs as **packages** (`tasks/orchestration/PACKAGES.md`), one per worker
session, each in its own git worktree. Your assignment (in your session file,
`tasks/orchestration/sessions/<session-id>.md`) says which tasks, which paths
you own, and which branch and worktree to use. These rules apply in **both
repos** (testa-platform and crobot). Read the repo's `AGENTS.md` /
`CLAUDE.md` and the PRD sections your tasks cite first; for testa-platform,
PRD-006 **Parts 5–6 win** and `docs/prds/006-validation.md` holds the goldens.

Order inside a package: as listed in your assignment. One commit per task on
the package branch. All repo guardrails apply.

## Per-task loop

For each task, in order:

1. Set `status: in_progress` in the task file (not `tasks/README.md`; P6 owns it).
2. Implement, following the task's Acceptance criteria.
3. Run the gates. **All must pass:**
   - **G1, package:** typecheck + tests of every package you touched
     (`pnpm --filter <pkg> typecheck && pnpm --filter <pkg> test`; collector:
     `bun test`).
   - **G2, task validation:** the commands in the task's **Validation gate**
     section (unit, integration and V-flows listed there).
   - **G3, repo:** testa-platform `pnpm -r typecheck && pnpm -r test && pnpm lint`;
     crobot (inside `crb-php` in your worktree) `php artisan test &&
     vendor/bin/phpstan analyse && npm run build`.
     Failures in code another package owns, caused by its unfinished work:
     note them in your report and don't fix them.
4. On green: commit, set `status: done` in **your task file only**, fill
   `commits` / `completed_at`, and append a one-line `## Report` to your
   session file: `<task> ✅ <sha> — <one line> — gates G1 G2 G3`.

## When a gate fails

- Fix and re-run, up to **3 attempts per gate**.
- **Never** to get green: delete or skip tests, loosen tolerances or golden
  values in `006-validation.md`, catch-and-ignore errors, or `@ts-ignore`. If
  a spec value itself looks wrong, record why in your report under
  **Questions for human** and keep the spec value.
- Still red after 3 attempts: set `status: blocked`, log the failing command
  and the last error in your report, then **continue with the next task whose
  `blocked_by` doesn't include it**. Skip tasks that depend on it.

## Stop the package (and send your final report) only if

- A guardrail action would be required (deploy, remote DB, secrets).
- A required tool is missing (`bun`, `docker`, `pnpm`, Playwright browsers).
  Surface it; don't silently skip.
- The PRD doesn't cover a decision **and** the guess would change the
  public API (`packages/shared-types`, the sync API shapes, crobot API
  resources). Smaller gaps: pick the simplest option, note it under
  **Assumptions** in your report, and continue.

## End of session

1. All your tasks are done or blocked, and G3 is green except for failures in
   code other packages own.
2. Your final report is complete: Done, Blocked, Assumptions, Questions for
   human, Requests for other packages, last SHA.
3. Branch committed, unpushed. The full `pnpm prd006:validate` run happens in
   P6. Stop and wait for the orchestrator.
