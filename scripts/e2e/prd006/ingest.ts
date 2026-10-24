/**
 * Loading fixtures through the real paths (task 5.14 steps 4–6): project
 * configs via the config API (Bearer token), events via HMAC-signed
 * `POST /_ingest` batches of 500 (X0's `ingestEvents`), then a wait until
 * ClickHouse `events` holds every row (no OPTIMIZE).
 *
 * F2 is generated as raw rows; it reaches the wire through X0's
 * `loadF1WireEvents`, which reads a samples-shaped directory. Writing the
 * rows to a temp dir in that layout reuses its encoding instead of copying it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http } from '../cross/lib/http.ts';
import { type WireEvent, loadF1WireEvents } from '../cross/shared/f1-wire.ts';
import { ingestEvents, waitForEventRows } from '../cross/shared/ingest-client.ts';
import type { HarnessConfig } from './config.ts';
import { expectedStored } from './fixtures/wire.ts';
import type { Sim } from './raw.ts';

export const INGEST_BATCH = 500;

export interface ExperimentSpec {
  readonly id: number;
  readonly variations: readonly { readonly id: number; readonly weight: number }[];
  /** Default `v2`; V8 needs a `v1` experiment for 409. */
  readonly version?: 'v1' | 'v2';
}

/** Publish a project config (crobot ProjectResource shape) through the config API. */
export async function publishConfig(
  cfg: HarnessConfig,
  projectId: number,
  experiments: readonly ExperimentSpec[],
): Promise<void> {
  const body = {
    id: projectId,
    name: `prd006 ${projectId}`,
    experiments: experiments.map((e) => ({
      identifier: e.id,
      title: `exp ${e.id}`,
      url: 'https://shop.example',
      url_match_type: 'contains',
      traffic: 100,
      type: 'copy',
      status: 'active',
      platform_version: e.version ?? 'v2',
      variations: e.variations.map((v) => ({ identifier: v.id, traffic: v.weight, changes: [] })),
    })),
  };
  const res = await http({
    url: `${cfg.collectorUrl}/api/v1/config/${projectId}`,
    headers: { authorization: `Bearer ${cfg.secrets.config}` },
    body,
  });
  if (res.status >= 300)
    throw new Error(`config publish ${projectId} → ${res.status}: ${res.text.slice(0, 200)}`);
}

export interface IngestStats {
  readonly events: number;
  readonly accepted: number;
  readonly batches: number;
  readonly ms: number;
}

/** Ingest wire events for one project and wait until ClickHouse has them all. */
export async function ingestProject(
  cfg: HarnessConfig,
  projectId: number,
  events: readonly WireEvent[],
): Promise<IngestStats> {
  const started = performance.now();
  const res = await ingestEvents(cfg.collectorUrl, cfg.secrets.ingest, events, INGEST_BATCH);
  // Accepted minus what the events TTL drops on insert (old non-experiment page_views).
  const stored = res.accepted - (events.length - expectedStored(events));
  await waitForEventRows(cfg.ch, `project_id = ${Number(projectId)}`, stored, 300_000);
  return {
    events: events.length,
    accepted: res.accepted,
    batches: res.batches,
    ms: performance.now() - started,
  };
}

/** Raw rows → wire events through X0's encoder (session_idx ranks, items, props). */
export function simToWire(sim: Sim): WireEvent[] {
  const root = mkdtempSync(join(tmpdir(), 'prd006-wire-'));
  try {
    const dir = join(root, 'docs', 'reference', 'samples', 'f1', 'raw');
    mkdirSync(dir, { recursive: true });
    const jsonl = (rows: readonly unknown[]) =>
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
    writeFileSync(join(dir, 'events.jsonl'), jsonl(sim.events));
    writeFileSync(join(dir, 'event_items.jsonl'), jsonl(sim.items));
    return [...loadF1WireEvents(root).events];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
