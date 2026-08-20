---
id: "P.5"
title: "Playwright browser e2e — no-flicker, sticky, targeting, cross-domain"
phase: "P"
status: pending
estimate_days: 1.5
blocked_by: []
files_to_create:
  - demo/next-split-url/e2e/split-url.spec.ts
  - demo/next-split-url/playwright.config.ts
references:
  - demo/next-split-url/
  - packages/next/src/middleware.ts
commits: []
completed_at: null
---

## Goal

Real-browser end-to-end coverage. Everything so far is `curl`-verified; prove the
behaviour in an actual browser before prod.

## Context

The demo (`demo/next-split-url`, App Router, :3100) redirects via the middleware
against a live config. Drive it with Playwright.

## Acceptance criteria

- [ ] **No flicker:** on an initial load bucketed to the variant, the control page
      never paints — assert navigation lands on `/pricing-v2` with no intermediate
      `/pricing` render (network + no control DOM).
- [ ] **Sticky:** a variant visitor stays variant across reloads; control stays control.
- [ ] **Targeting:** `/pricing` (no utm) does NOT enroll; `/pricing?utm_source=facebook`
      does; a returning enrolled visitor stays in even without the utm (cookie-first).
- [ ] **Traffic split:** N fresh contexts split ≈ per the allocation (not starved).
- [ ] **Soft-nav:** clicking an in-app `<Link>` — document current behaviour (hard
      reload vs SPA) using the reload-sentinel; ties into N.5/N.6.
- [ ] **Cross-domain (optional):** a `_testa_cd`-tagged landing applies the carried
      assignment.
- [ ] Wired into CI (or a documented `pnpm --filter @testa-demo/next-split-url e2e`).
