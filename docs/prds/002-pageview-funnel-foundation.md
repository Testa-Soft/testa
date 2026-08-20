# PRD 002 — page_view funnel foundation (MVP)

**Status:** needs-triage
**Owner:** unassigned
**Date:** 2026-07-08
**Origin:** grill-me session 2026-07-08 (design decisions locked below)

## Problem Statement

We want to map our clients' funnels — all landing pages, the full user
journey — so we can monitor the health of AB tests and iterate on them.
Today none of the raw material exists:

- The pixel emits **no `page_view` event**. The only auto-emitted event is
  `experiment_view` (`apps/pixel/src/runtime/lifecycle.ts:573/578`).
  `page_view` exists only as a reserved name in the type union
  (`packages/shared-types/src/event.ts`) and is never fired.
- The collector stores events but has **no journey/session/funnel model**.
  The `events` table is `ORDER BY (project_id, event_name, client_ts)` —
  event_name-first, not visitor/session — and there is no ordered-sequence
  storage, no `windowFunnel`/`sequenceMatch` query, and no page-path model.
  `FunnelStep`/`FunnelMetric`/`SessionsMetric` are typed in
  `packages/shared-types/src/metric-summary.ts` but unimplemented.

The pixel already carries every identifier a page_view needs
(`event_id` UUIDv7, persistent `visitor_id` from `_testa_uuid`,
`session_id` from `_testa_sid` @ 30-min sliding TTL, `url`, `referrer`,
`consent_state`) via `buildPixelEvent` — so this is about *emitting* the
event, *storing* it affordably, and making it *sampleable*, not new
identifier plumbing.

## Scope of THIS plan

This PRD covers **layers 1–2 only**, in `testa-platform`:

1. **Pixel** emits `page_view`.
2. **Edge + Collector** store it with differential (cheap) retention and
   keep it queryable + sampleable.

Explicitly **deferred to the crobot workstream** (out of scope here):

3. Sampling + URL-template **extraction** job → candidate page map.
4. Client **verification UI** for the page map.
5. Phase **B**: per-variation experiment **funnels** (`windowFunnel`)
   over classified/sessionized data.

## Design decisions (locked in the grill-me session)

### Product framing
- **Path mining first (descriptive), AB-test-health funnels are phase B.**
  We build the sessionizable base now; the experiment-funnel overlay comes
  later and reuses it.
- **Page identity = auto dynamic-segment collapse** (`/product/12345` →
  `/product/:id`). This is a *learned + client-verified* dictionary, **not**
  a hardcoded heuristic — and it lives in **crobot**, produced by the
  extraction job and curated in the verification UI. The collector does
  **not** store a normalized `page_path`; it stores raw `url` only.
- **MVP, not foolproof.** Approximate is fine; the client verification loop
  (layer 4) is where the map gets corrected.

### The sampled-analysis model (why there is no sessions table)
- The collector already stores **every** raw event, so "map a journey" is an
  **analysis-time query over a random sample**: pick N random
  `visitor_id`s / `session_id`s, pull their page_views in `client_ts` order.
- Therefore **no materialized sessions/journey table, no MV rollup, no
  reorder of the events table** for MVP.
- **"Both grains" (session + visitor) is free**: it's just whether crobot's
  sampling query does `GROUP BY session_id` vs `GROUP BY visitor_id` over the
  same rows. Visitor-grain is **"stitched, approximate"** — undercounts under
  Safari/ITP cookie caps on `_testa_uuid`.

### Retention — differential, prospective, pixel-stamped
- The pixel stamps each page_view with **`in_experiment` (boolean only)**,
  from the resolved experiment cycle.
- ClickHouse **event_name-scoped** conditional TTL (must NOT reap conversions):

  ```sql
  TTL toDateTime(client_ts) + INTERVAL 1 DAY   DELETE
        WHERE event_name = 'page_view' AND in_experiment = 0,
      toDateTime(client_ts) + INTERVAL 30 DAY  DELETE
        WHERE event_name = 'page_view' AND in_experiment = 1,
      toDateTime(client_ts) + INTERVAL 13 MONTH DELETE
  ```

- **Prospective only.** ClickHouse cannot raise a row's TTL after write
  (TTL derives from the row's own columns; no cross-row lookup, no "UPDATE
  TTL"). So page_views *before* a visitor's first exposure stay
  `in_experiment=0` and are reaped at 1 day — we **accept losing the
  pre-exposure lead-in** for MVP. (Retroactive capture would need an
  hourly promotion job copying rows into a 30d table before the 1d TTL
  reaps them — rejected for MVP.)
- **Attribution is not stored on page_view** — recover it later by joining
  page_views to `experiment_view` on `session_id` (~same `client_ts`), which
  already carries exact `experiment_id`/`variation_id` and also re-fires on
  every SPA transition. No data lost; a phase-B join instead of write-time
  columns.

### Volume protection (page_view is a 10–50× ingest increase)
- **Pixel: detect crawlers and skip the page_view emit entirely**, ported
  from legacy **3.3.3 `script.js`** crawler guard (lives in **crobot**, not
  this repo — `crobot/.../3.3.3/script.js`). Doing this in the pixel is
  strictly better than an edge drop: a skipped crawler never hits HMAC/edge/
  Redis/ClickHouse at all. (This replaces the edge `is_bot` drop; the edge's
  UA-derived `is_bot` still exists for enrichment but is not the page_view
  gate.)
- **Pixel: per-session cap of 50 page_views** — bounds pathological SPAs and
  redirect/render loops. Humans are otherwise uncapped (consistent with the
  platform's "no rate limiting, circuit-breaker only" philosophy).

## Implementation

### Layer 1 — Pixel (`apps/pixel`)
- Emit `page_view` on **initial load** and on **each meaningful SPA
  `onTransition`**, reusing the existing debounced, same-URL-deduped handler
  in `src/runtime/spa.ts` (no new navigation detection needed).
- Fire **at the end of `runExperimentCycle`, error-isolated** (own
  try/catch), so `in_experiment` is accurate and a page_view still fires if
  variation application partially fails.
- Fire **even when no experiment matches** → `in_experiment = 0`.
- **Crawler guard:** detect crawlers/bots and **skip the page_view emit**
  (port the 3.3.3 `script.js` crawler check from crobot). No pixel bot
  detection exists today — this is net-new ported code.
- Payload: reuse `buildPixelEvent` (`url` = full href, `referrer`,
  `session_id`, `visitor_id`, `consent_state`) + new **`in_experiment`**
  boolean. No experiment ids on the row.
- **Per-session cap:** stop emitting after **50** page_views/session.
- **Redirect variations:** do not emit for the page being navigated away
  from — the destination page fires its own page_view.

### Layer 2 — Edge + Collector (`apps/collector` + edge)
- **Edge:** no page_view-specific change — crawler filtering now happens in
  the pixel (above). The edge's UA `is_bot` enrichment is unchanged.
- **Collector schema migration:** add `in_experiment UInt8 DEFAULT 0` to the
  events table; wire it through `EventsRow` + `rowFromEvent`
  (`apps/collector/src/db/row-mapper.ts`) and the `PixelEvent`/`EnrichedEvent`
  wire types (`packages/shared-types/src/event.ts`). **No `page_path`
  column.**
- **Migration:** replace the single 13-month TTL with the event_name-scoped
  differential TTL above.
- **No `SAMPLE BY`, no reorder.** `event_name`-first sort key already makes
  `WHERE project_id = X AND event_name = 'page_view'` a clean prefix range
  scan; the 1-day TTL keeps the non-experiment bulk small. Revisit only if
  sampling proves slow.

## Accepted MVP limitations (document, don't fix)
- **Pre-exposure lead-in lost:** page_views before a visitor's first
  experiment exposure are reaped at 1 day.
- **Visitor-grain journeys undercount** under Safari/ITP cookie caps
  ("stitched, approximate").
- **First-event ephemeral visitor_id:** the very first page_view of a
  brand-new visitor may carry an ephemeral `crypto.randomUUID()` before the
  `_testa_uuid` cookie is written, so it won't stitch to later events — a
  minor front-of-first-session gap. (Verify cookie-write ordering in
  `lifecycle.ts` if this matters.)
- **Auto-collapse mis-templates** some static segments (e.g.
  `/pricing/enterprise`, country codes) — precisely what the client
  verification loop exists to fix.

## Open items owned by the crobot workstream
- **Read seam:** collector sampling endpoint (e.g.
  `GET /api/v1/sample/sessions?project&n&window`) vs crobot reading
  ClickHouse directly. Deferred; this plan only guarantees page_views are
  queryable + sampleable. Minor risk this surfaces a late collector change.
- Extraction job cadence/trigger ("every now and then"), sampling size,
  template heuristic.
- Page-map storage (likely crobot/Postgres relational config, not
  ClickHouse) + verification UI.
- Phase B experiment funnels.

## Test Plan (TODO)
- [ ] Pixel unit: page_view fires once on load, once per SPA transition,
      deduped on same-URL replaceState, capped at 50/session.
- [ ] Pixel unit: `in_experiment` = 1 when an experiment matched, 0 when
      none matched; page_view still fires when the cycle throws mid-apply.
- [ ] Pixel crawler guard: known crawler UAs skip the page_view emit
      entirely; a normal UA emits. (Port + test against the 3.3.3 UA set.)
- [ ] Collector migration: `in_experiment` column present; differential TTL
      applied.
- [ ] TTL correctness: a `purchase` and an `in_experiment=1` page_view
      survive past 1 day; an `in_experiment=0` page_view is reaped at 1 day.
- [ ] Sample query: N random visitors' page_views return in `client_ts`
      order for both `session_id` and `visitor_id` grouping.
