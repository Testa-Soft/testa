# Architecture — Collector

The **collector** is a Bun + Hono service that:

1. Accepts HMAC-signed batches of events from the edge worker (`POST /_ingest`).
2. Pushes each event onto a Redis Stream (`events`).
3. A separate Bun process drains the stream and INSERTs into ClickHouse.
4. Serves the config API (`/api/v1/config/:projectId`) — testa-platform owns the servable project configs.
5. Runs the PRD-006 **modeler** (third process): scheduler + workers that turn raw events into additive daily rows (`metric_daily`) per subscribed experiment, plus on-demand query views.
6. Exposes the PRD-006 **sync API** (`/api/v1/experiments/*`) that crobot pulls those rows from, and the stateless **stats** endpoint (`POST /api/v1/stats`).

The collector is the **only service that talks to ClickHouse**. Crobot does NOT have a CH client.

## Three processes from one source

```
apps/collector/
├── src/
│   ├── index.ts            HTTP server entry (Hono)
│   ├── consumer/main.ts    Consumer process entry (no HTTP server)
│   ├── config.ts           Zod-validated env
│   ├── ingest/             POST /_ingest implementation (Phase 1.4)
│   ├── consumer/           XREADGROUP loop, batch INSERT (Phase 1.5)
│   ├── modeler/main.ts     Modeler process entry (scheduler + workers; --once for one pass)
│   ├── modeler/            daily rows builder, queue, run state, query jobs, webhooks (PRD-006 5.9/5.15)
│   ├── sync/               /api/v1/experiments/* sync API (PRD-006 5.8, R3 project scoping)
│   ├── analytics/          shared attribution SQL, view registry, guards, errors (5.18)
│   ├── products/ distributions/ health/   query views (5.16, 5.17)
│   ├── stats/              POST /api/v1/stats — Bayesian Monte Carlo (5.10, 5.11)
│   ├── config/             config API + store (numeric project_id alias)
│   ├── fx/                 Frankfurter sync + backfill, previous-day FX SQL (1.6, 5.19)
│   ├── db/                 ClickHouse client, row mapping (events + event_items), migrations
│   └── auth/               HMAC verify + service token verify
```

Run as three separate Bun processes (Docker containers / systemd units in production):

```sh
bun run dev:server      # or production: bun src/index.ts
bun run dev:consumer    # or production: bun src/consumer/main.ts
bun run dev:modeler     # or production: bun src/modeler/main.ts  (--once / MODELER_ONCE=1: one pass)
```

This split means write throughput (server), CH write rate (consumer) and modeling load (modeler) scale independently. The server and the modeler must share Redis, ClickHouse, `CONFIG_DIR` and `MODELER_KEY_PREFIX`.

## /_ingest write path

```
POST /_ingest
Headers:
  Content-Type: application/json
  X-Edge-Signature: <hex-encoded HMAC-SHA256 of `${signed_at}.${body}` using INGEST_SHARED_SECRET>

Body (matches IngestBatch from shared-types):
{
  "signed_at": 1730902400123,
  "events": [
    { "event_id": "uuid", "event_name": "page_view", ... },
    ...
  ]
}

Response: 204 on success, 401 on bad signature, 400 on schema/replay-window failure
```

Handler:

```ts
1. Parse `signed_at` from body. Reject if |now - signed_at| > INGEST_REPLAY_WINDOW.
2. Compute HMAC-SHA256(`${signed_at}.${rawBody}`, INGEST_SHARED_SECRET).
   Compare via timing-safe equal to X-Edge-Signature. Reject 401 on mismatch.
3. Zod-validate body.events against IngestBatch.events schema. Reject 400 on fail.
4. For each event:
     if event.event_name in INGEST_DEDUP_EVENT_NAMES:
       SET event:seen:<event_id> 1 EX 600 NX
       if reply == nil: skip (duplicate)
     XADD events * <payload>
5. Return 204.
```

## Idempotency

Pixel-side IDB outbox means a given `event_id` (UUIDv7, generated at the pixel) may be POSTed multiple times: edge retries on 5xx, the entire batch retries when the pixel hasn't seen a success yet, etc. Without dedup, duplicates would inflate `sum()` and `count()` aggregates: total revenue, orders count, page views count, RPV all over-stated. AOV is robust by construction (proportional cancellation in numerator and denominator) but RPV and absolute revenue are not.

The dedup mechanism is **Redis `SET ... NX EX 600` before `XADD`**, applied only to event names in a configurable allow-list (`INGEST_DEDUP_EVENT_NAMES`, default `['purchase']`):

```
on /_ingest, for each event:
  if event.event_name in DEDUP_EVENT_NAMES:
    SET event:seen:<event_id> 1 EX 600 NX
    if reply == nil:
      skip (duplicate; do NOT XADD)
      log _pixel_health late-arrival counter
  XADD events * payload   -- always for events that pass the dedup check
```

Why this design:

- **`SETNX` semantics fit perfectly**: only the first observer of an `event_id` gets a successful reply; retries fail loudly and are skipped.
- **Allow-list, not all-events**: Most event types are immune to duplication anyway (sessions, visitor counts use `uniqExact`). Only `purchase` events directly inflate `sum(value_native)` and `count()` in the aggregates customers reconcile against external systems. Other event types can be opted-in later by extending the env var (e.g. `purchase,email_submit`).
- **10-min TTL** comfortably covers the 5-min HMAC replay window and gives slack for IDB outbox flushes that spent extra time on a slow network.
- **Pipelined**: `(SET, XADD)` for each event in one Redis pipeline — single round trip per batch.
- **Memory cost**: at 250 ev/s × ~10% purchase mix × 600 s ≈ 15k keys ≈ ~1 MB. Negligible.

CH `events` table stays a plain `MergeTree`. No `ReplacingMergeTree`, no `FINAL`, no schema disruption. Dedup is entirely upstream.

> **Why not deterministic stream entry IDs (`XADD events <event_id>-...`)?** Earlier drafts of this doc proposed that. It doesn't work: Redis Streams require strictly monotonically increasing IDs *across the entire stream*, so you can't reliably encode a per-event-id dedup key into the stream entry ID. Out-of-order producers would fail. `SETNX`-before-`XADD` is the standard Redis dedup pattern.

Throughput target at peak: **250 batched req/s** (assuming ~100 events/batch). Each request does N XADDs (N up to 100). Bun + ioredis comfortably exceeds this.

## Consumer

Long-running Bun process. Single instance for v1 (Redis Streams support consumer groups, so we can scale horizontally later).

```
loop forever:
  results = await redis.xreadgroup(
    'GROUP', 'collector-writers', consumerName,
    'COUNT', batchSize,                                    // 1000
    'BLOCK', flushIntervalMs,                              // 5000
    'STREAMS', 'events', '>'
  );

  if (results) {
    rows = results.flatMap(parseEvent);                    // [event_id, ts, ...]
    await ch.insert({ table: 'events_buffer', values: rows, format: 'JSONEachRow' });
    await redis.xack('events', 'collector-writers', ...messageIds);
  }

  // pending recovery: every 60s, claim & retry messages stuck for >30s
```

On CH 5xx: don't XACK. Sleep with exponential backoff. Re-read with `0` instead of `>` to retry the same batch.

On CH 4xx (schema mismatch): log + XACK to drop the batch. Investigate offline.

Graceful shutdown: on SIGTERM, finish current batch, XACK, then exit.

## Read path (PRD-006)

Diagram: `diagrams/03-read-path.mmd`. Contract: `docs/reference/api-endpoints.md` (sync API, stats) and PRD-006 Part 3.

1. **Subscribe.** Crobot `PUT /api/v1/experiments/:id/subscription` (body carries `project_id`). Stored in `metric_subscriptions` (ReplacingMergeTree); a new / changed / stopped subscription enqueues a refresh at high priority.
2. **Model.** The modeler scheduler (every `MODELER_INTERVAL_SEC`) enqueues running subscriptions with newer events, a failed or missing run, or a run older than 24 h; stopped ones get one final run (`is_final = 1`). Workers take a per-experiment lock, compute every subscribed metric for `[from, to ?? today]` (`computeDailyRows`: exposed set from `exposures` ⟕ attributed events / `event_items`, purchases deduped, FX at the previous day's rate), insert the rows under a new `run_id`, then flip `last_ready_run_id` in Redis — readers never see half a run. 1 attempt + 3 retries, then `failed` with the last good run still served.
3. **Pull.** Crobot `GET …/daily-summary?project_id=&since_run_id=` — status + the last ready run's rows from `metric_daily`. Never computes.
4. **Extras.** `POST …/queries` (summary with a dimension / outlier capping, products, distributions, health) run on the same queue at higher priority; results cached 1 h in Redis.
5. **Significance.** Crobot sums rows and calls `POST /api/v1/stats`.

Experiment ids are unique per project only, so subscriptions, run state, locks and query ids are project-scoped (R3). The collector checks `X-Service-Token`, that the experiment exists in the project's config (`experiment_not_found`) and is `platform_version: "v2"` (`version_mismatch`); user-level permissions stay in crobot.

The pre-PRD-006 read API (`GET /api/v1/metrics/*`, `mv_aov_daily` / `mv_rpv_*`) was never built and its MVs were dropped (migrations 019–021).

## ClickHouse interaction

- HTTP interface (`@clickhouse/client`), not native TCP. Simpler, fine for our throughput.
- Inserts go to `events_buffer` (a `Buffer`-engine table that flushes to `events` automatically). Smooths microbursts and reduces small-part count.
- Migrations are versioned SQL files in `db/migrations/`, applied by `bun run migrate`. Track applied migrations in `_migrations` table on CH itself.

## See also

- `docs/architecture/03-data-model.md` — full CH schema
- `docs/reference/clickhouse-schema.md` — DDL
- `docs/reference/api-endpoints.md` — endpoint specs (request/response)
- `docs/prds/006-ecommerce-events-and-metric-modeling.md` — PRD-006 (events, modeling, sync API, stats)
- `docs/reference/samples/` — reference oracle (`generate.py`) + modeled examples
- `docs/reference/hmac-protocol.md` — HMAC details
